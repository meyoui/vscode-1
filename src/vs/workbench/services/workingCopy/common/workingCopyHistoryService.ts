/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from 'vs/nls';
import { Emitter } from 'vs/base/common/event';
import { assertIsDefined } from 'vs/base/common/types';
import { Registry } from 'vs/platform/registry/common/platform';
import { IWorkbenchContributionsRegistry, Extensions as WorkbenchExtensions } from 'vs/workbench/common/contributions';
import { LifecyclePhase } from 'vs/workbench/services/lifecycle/common/lifecycle';
import { WorkingCopyHistoryTracker } from 'vs/workbench/services/workingCopy/common/workingCopyHistoryTracker';
import { Disposable } from 'vs/base/common/lifecycle';
import { IWorkingCopyHistoryEntry, IWorkingCopyHistoryEntryDescriptor, IWorkingCopyHistoryEvent, IWorkingCopyHistoryService, MAX_PARALLEL_HISTORY_IO_OPS } from 'vs/workbench/services/workingCopy/common/workingCopyHistory';
import { FileOperation, FileOperationError, FileOperationEvent, FileOperationResult, IFileService, IFileStatWithMetadata } from 'vs/platform/files/common/files';
import { IRemoteAgentService } from 'vs/workbench/services/remote/common/remoteAgentService';
import { URI } from 'vs/base/common/uri';
import { DeferredPromise, Limiter } from 'vs/base/common/async';
import { dirname, extname, isEqual, joinPath } from 'vs/base/common/resources';
import { IEnvironmentService } from 'vs/platform/environment/common/environment';
import { hash } from 'vs/base/common/hash';
import { indexOfPath, randomPath } from 'vs/base/common/extpath';
import { CancellationToken } from 'vs/base/common/cancellation';
import { ResourceMap } from 'vs/base/common/map';
import { IUriIdentityService } from 'vs/platform/uriIdentity/common/uriIdentity';
import { ILabelService } from 'vs/platform/label/common/label';
import { VSBuffer } from 'vs/base/common/buffer';
import { ILogService } from 'vs/platform/log/common/log';
import { SaveSource, SaveSourceRegistry } from 'vs/workbench/common/editor';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { lastOrDefault } from 'vs/base/common/arrays';

interface ISerializedWorkingCopyHistoryModel {
	readonly version: number;
	readonly resource: string;
	readonly entries: ISerializedWorkingCopyHistoryModelEntry[];
}

interface ISerializedWorkingCopyHistoryModelEntry {
	readonly id: string;
	readonly timestamp: number;
	readonly source?: SaveSource;
}

export class WorkingCopyHistoryModel {

	static readonly ENTRIES_FILE = 'entries.json';

	private static readonly FILE_SAVED_SOURCE = SaveSourceRegistry.registerSource('default.source', localize('default.source', "File Saved"));

	private static readonly SETTINGS = {
		MAX_ENTRIES: 'workbench.localHistory.maxFileEntries',
		MERGE_PERIOD: 'workbench.localHistory.mergePeriod'
	};

	private entries: IWorkingCopyHistoryEntry[] = [];

	private whenResolved: Promise<void> | undefined = undefined;

	private workingCopyResource: URI | undefined = undefined;
	private workingCopyName: string | undefined = undefined;

	private historyEntriesFolder: URI | undefined = undefined;
	private historyEntriesListingFile: URI | undefined = undefined;

	private historyEntriesNameMatcher: RegExp | undefined = undefined;

	private shouldStore: boolean = false;

	constructor(
		workingCopyResource: URI,
		private readonly historyHome: URI,
		private readonly entryAddedEmitter: Emitter<IWorkingCopyHistoryEvent>,
		private readonly entryChangedEmitter: Emitter<IWorkingCopyHistoryEvent>,
		private readonly entryReplacedEmitter: Emitter<IWorkingCopyHistoryEvent>,
		private readonly entryRemovedEmitter: Emitter<IWorkingCopyHistoryEvent>,
		private readonly fileService: IFileService,
		private readonly labelService: ILabelService,
		private readonly logService: ILogService,
		private readonly configurationService: IConfigurationService
	) {
		this.setWorkingCopy(workingCopyResource);
	}

	private setWorkingCopy(workingCopyResource: URI): void {

		// Update working copy
		this.workingCopyResource = workingCopyResource;
		this.workingCopyName = this.labelService.getUriBasenameLabel(workingCopyResource);

		this.historyEntriesNameMatcher = new RegExp(`[A-Za-z0-9]{4}${extname(workingCopyResource)}`);

		// Update locations
		this.historyEntriesFolder = this.toHistoryEntriesFolder(this.historyHome, workingCopyResource);
		this.historyEntriesListingFile = joinPath(this.historyEntriesFolder, WorkingCopyHistoryModel.ENTRIES_FILE);

		// Reset entries and resolved cache
		this.entries = [];
		this.whenResolved = undefined;
	}

	private toHistoryEntriesFolder(historyHome: URI, workingCopyResource: URI): URI {
		return joinPath(historyHome, hash(workingCopyResource.toString()).toString(16));
	}

	async addEntry(source = WorkingCopyHistoryModel.FILE_SAVED_SOURCE, timestamp = Date.now(), token: CancellationToken): Promise<IWorkingCopyHistoryEntry> {
		let entryToReplace: IWorkingCopyHistoryEntry | undefined = undefined;

		// Figure out if the last entry should be replaced based
		// on settings that can define a interval for when an
		// entry is not added as new entry but should replace.
		// However, when save source is different, never replace.
		const lastEntry = lastOrDefault(this.entries);
		if (lastEntry && lastEntry.source === source) {
			const configuredReplaceInterval = this.configurationService.getValue<number>(WorkingCopyHistoryModel.SETTINGS.MERGE_PERIOD, { resource: this.workingCopyResource });
			if (timestamp - lastEntry.timestamp <= (configuredReplaceInterval * 1000 /* convert to millies */)) {
				entryToReplace = lastEntry;
			}
		}

		// Replace lastest entry in history
		if (entryToReplace) {
			return this.doReplaceEntry(entryToReplace, timestamp, token);
		}

		// Add entry to history
		else {
			return this.doAddEntry(source, timestamp, token);
		}
	}

	private async doAddEntry(source: SaveSource, timestamp: number, token: CancellationToken): Promise<IWorkingCopyHistoryEntry> {
		const workingCopyResource = assertIsDefined(this.workingCopyResource);
		const workingCopyName = assertIsDefined(this.workingCopyName);
		const historyEntriesFolder = assertIsDefined(this.historyEntriesFolder);

		// Perform a fast clone operation with minimal overhead to a new random location
		const id = `${randomPath(undefined, undefined, 4)}${extname(workingCopyResource)}`;
		const location = joinPath(historyEntriesFolder, id);
		await this.fileService.cloneFile(workingCopyResource, location);

		// Add to list of entries
		const entry: IWorkingCopyHistoryEntry = {
			id,
			workingCopy: { resource: workingCopyResource, name: workingCopyName },
			location,
			timestamp,
			source
		};
		this.entries.push(entry);

		// Mark as in need to be stored to disk
		this.shouldStore = true;

		// Events
		this.entryAddedEmitter.fire({ entry });

		return entry;
	}

	private async doReplaceEntry(entry: IWorkingCopyHistoryEntry, timestamp: number, token: CancellationToken): Promise<IWorkingCopyHistoryEntry> {
		const workingCopyResource = assertIsDefined(this.workingCopyResource);

		// Perform a fast clone operation with minimal overhead to the existing location
		await this.fileService.cloneFile(workingCopyResource, entry.location);

		// Update entry
		entry.timestamp = timestamp;

		// Mark as in need to be stored to disk
		this.shouldStore = true;

		// Events
		this.entryReplacedEmitter.fire({ entry });

		return entry;
	}

	async removeEntry(entry: IWorkingCopyHistoryEntry, token: CancellationToken): Promise<boolean> {

		// Make sure to await resolving when removing entries
		await this.resolveEntriesOnce();

		if (token.isCancellationRequested) {
			return false;
		}

		const index = this.entries.indexOf(entry);
		if (index === -1) {
			return false;
		}

		// Delete from disk
		await this.deleteEntry(entry);

		// Remove from model
		this.entries.splice(index, 1);

		// Mark as in need to be stored to disk
		this.shouldStore = true;

		// Events
		this.entryRemovedEmitter.fire({ entry });

		return true;
	}

	async updateEntry(entry: IWorkingCopyHistoryEntry, properties: { source: SaveSource }, token: CancellationToken): Promise<void> {

		// Make sure to await resolving when updating entries
		await this.resolveEntriesOnce();

		if (token.isCancellationRequested) {
			return;
		}

		const index = this.entries.indexOf(entry);
		if (index === -1) {
			return;
		}

		// Update entry
		entry.source = properties.source;

		// Mark as in need to be stored to disk
		this.shouldStore = true;

		// Events
		this.entryChangedEmitter.fire({ entry });
	}

	async getEntries(): Promise<readonly IWorkingCopyHistoryEntry[]> {

		// Make sure to await resolving when all entries are asked for
		await this.resolveEntriesOnce();

		// Return as many entries as configured by user settings
		const configuredMaxEntries = this.configurationService.getValue<number>(WorkingCopyHistoryModel.SETTINGS.MAX_ENTRIES, { resource: this.workingCopyResource });
		if (this.entries.length > configuredMaxEntries) {
			return this.entries.slice(this.entries.length - configuredMaxEntries);
		}

		return this.entries;
	}

	async hasEntries(skipResolve: boolean): Promise<boolean> {

		// Make sure to await resolving unless explicitly skipped
		if (!skipResolve) {
			await this.resolveEntriesOnce();
		}

		return this.entries.length > 0;
	}

	private resolveEntriesOnce(): Promise<void> {
		if (!this.whenResolved) {
			this.whenResolved = this.doResolveEntries();
		}

		return this.whenResolved;
	}

	private async doResolveEntries(): Promise<void> {

		// Resolve from disk
		const entries = await this.resolveEntriesFromDisk();

		// We now need to merge our in-memory entries with the
		// entries we have found on disk because it is possible
		// that new entries have been added before the entries
		// listing file was updated
		for (const entry of this.entries) {
			entries.set(entry.id, entry);
		}

		// Set as entries, sorted by timestamp
		this.entries = Array.from(entries.values()).sort((entryA, entryB) => entryA.timestamp - entryB.timestamp);
	}

	private async resolveEntriesFromDisk(): Promise<Map<string /* ID */, IWorkingCopyHistoryEntry>> {
		const workingCopyResource = assertIsDefined(this.workingCopyResource);
		const workingCopyName = assertIsDefined(this.workingCopyName);

		const [entryListing, entryStats] = await Promise.all([

			// Resolve entries listing file
			this.readEntriesFile(),

			// Resolve children of history folder
			this.readEntriesFolder()
		]);

		// Add from raw folder children
		const entries = new Map<string, IWorkingCopyHistoryEntry>();
		if (entryStats) {
			for (const entryStat of entryStats) {
				entries.set(entryStat.name, {
					id: entryStat.name,
					workingCopy: { resource: workingCopyResource, name: workingCopyName },
					location: entryStat.resource,
					timestamp: entryStat.mtime,
					source: WorkingCopyHistoryModel.FILE_SAVED_SOURCE
				});
			}
		}

		// Update from listing (to have more specific metadata)
		if (entryListing) {
			for (const entry of entryListing.entries) {
				const existingEntry = entries.get(entry.id);
				if (existingEntry) {
					entries.set(entry.id, {
						...existingEntry,
						timestamp: entry.timestamp,
						source: entry.source ?? existingEntry.source
					});
				}
			}
		}

		return entries;
	}

	async moveEntries(targetWorkingCopyResource: URI, source: SaveSource, token: CancellationToken): Promise<void> {

		// Ensure model stored so that any pending data is flushed
		await this.store(token);

		if (token.isCancellationRequested) {
			return undefined;
		}

		// Rename existing entries folder
		const sourceHistoryEntriesFolder = assertIsDefined(this.historyEntriesFolder);
		const targetHistoryFolder = this.toHistoryEntriesFolder(this.historyHome, targetWorkingCopyResource);
		try {
			await this.fileService.move(sourceHistoryEntriesFolder, targetHistoryFolder, true);
		} catch (error) {
			if (!(error instanceof FileOperationError && error.fileOperationResult === FileOperationResult.FILE_NOT_FOUND)) {
				this.traceError(error);
			}
		}

		// Update our associated working copy
		this.setWorkingCopy(targetWorkingCopyResource);

		// Add entry for the move
		await this.addEntry(source, undefined, token);

		// Store model again to updated location
		await this.store(token);
	}

	async store(token: CancellationToken): Promise<void> {
		const historyEntriesFolder = assertIsDefined(this.historyEntriesFolder);

		if (!this.shouldStore) {
			return; // fast return to avoid disk access when nothing changed
		}

		// Make sure to await resolving when persisting
		await this.resolveEntriesOnce();

		if (token.isCancellationRequested) {
			return undefined;
		}

		// Cleanup based on max-entries setting
		await this.cleanUpEntries();

		// Without entries, remove the history folder
		if (this.entries.length === 0) {
			try {
				await this.fileService.del(historyEntriesFolder, { recursive: true });
			} catch (error) {
				this.traceError(error);
			}
		}

		// If we still have entries, update the entries meta file
		else {
			await this.writeEntriesFile();
		}

		// Mark as being up to date on disk
		this.shouldStore = false;
	}

	private async cleanUpEntries(): Promise<void> {
		const configuredMaxEntries = this.configurationService.getValue<number>(WorkingCopyHistoryModel.SETTINGS.MAX_ENTRIES, { resource: this.workingCopyResource });
		if (this.entries.length <= configuredMaxEntries) {
			return; // nothing to cleanup
		}

		const entriesToDelete = this.entries.slice(0, this.entries.length - configuredMaxEntries);
		const entriesToKeep = this.entries.slice(this.entries.length - configuredMaxEntries);

		// Delete entries from disk as instructed
		for (const entryToDelete of entriesToDelete) {
			await this.deleteEntry(entryToDelete);
		}

		// Make sure to update our in-memory model as well
		// because it will be persisted right after
		this.entries = entriesToKeep;

		// Events
		for (const entry of entriesToDelete) {
			this.entryRemovedEmitter.fire({ entry });
		}
	}

	private async deleteEntry(entry: IWorkingCopyHistoryEntry): Promise<void> {
		try {
			await this.fileService.del(entry.location);
		} catch (error) {
			this.traceError(error);
		}
	}

	private async writeEntriesFile(): Promise<void> {
		const workingCopyResource = assertIsDefined(this.workingCopyResource);
		const historyEntriesListingFile = assertIsDefined(this.historyEntriesListingFile);

		const serializedModel: ISerializedWorkingCopyHistoryModel = {
			version: 1,
			resource: workingCopyResource.toString(),
			entries: this.entries.map(entry => {
				return {
					id: entry.id,
					source: entry.source !== WorkingCopyHistoryModel.FILE_SAVED_SOURCE ? entry.source : undefined,
					timestamp: entry.timestamp
				};
			})
		};

		await this.fileService.writeFile(historyEntriesListingFile, VSBuffer.fromString(JSON.stringify(serializedModel)));
	}

	private async readEntriesFile(): Promise<ISerializedWorkingCopyHistoryModel | undefined> {
		const historyEntriesListingFile = assertIsDefined(this.historyEntriesListingFile);

		let serializedModel: ISerializedWorkingCopyHistoryModel | undefined = undefined;
		try {
			serializedModel = JSON.parse((await this.fileService.readFile(historyEntriesListingFile)).value.toString());
		} catch (error) {
			if (!(error instanceof FileOperationError && error.fileOperationResult === FileOperationResult.FILE_NOT_FOUND)) {
				this.traceError(error);
			}
		}

		return serializedModel;
	}

	private async readEntriesFolder(): Promise<IFileStatWithMetadata[] | undefined> {
		const historyEntriesFolder = assertIsDefined(this.historyEntriesFolder);
		const historyEntriesNameMatcher = assertIsDefined(this.historyEntriesNameMatcher);

		let rawEntries: IFileStatWithMetadata[] | undefined = undefined;

		// Resolve children of folder on disk
		try {
			rawEntries = (await this.fileService.resolve(historyEntriesFolder, { resolveMetadata: true })).children;
		} catch (error) {
			if (!(error instanceof FileOperationError && error.fileOperationResult === FileOperationResult.FILE_NOT_FOUND)) {
				this.traceError(error);
			}
		}

		if (!rawEntries) {
			return undefined;
		}

		// Skip entries that do not seem to have valid file name
		return rawEntries.filter(entry =>
			!isEqual(entry.resource, this.historyEntriesListingFile) && // not the listings file
			historyEntriesNameMatcher.test(entry.name)					// matching our expected file pattern for entries
		);
	}

	private traceError(error: Error): void {
		this.logService.trace('[Working Copy History Service]', error);
	}
}

export abstract class WorkingCopyHistoryService extends Disposable implements IWorkingCopyHistoryService {

	private static readonly FILE_MOVED_SOURCE = SaveSourceRegistry.registerSource('moved.source', localize('moved.source', "File Moved"));
	private static readonly FILE_RENAMED_SOURCE = SaveSourceRegistry.registerSource('renamed.source', localize('renamed.source', "File Renamed"));

	declare readonly _serviceBrand: undefined;

	protected readonly _onDidAddEntry = this._register(new Emitter<IWorkingCopyHistoryEvent>());
	readonly onDidAddEntry = this._onDidAddEntry.event;

	protected readonly _onDidChangeEntry = this._register(new Emitter<IWorkingCopyHistoryEvent>());
	readonly onDidChangeEntry = this._onDidChangeEntry.event;

	protected readonly _onDidReplaceEntry = this._register(new Emitter<IWorkingCopyHistoryEvent>());
	readonly onDidReplaceEntry = this._onDidReplaceEntry.event;

	private readonly _onDidMoveEntries = this._register(new Emitter<void>());
	readonly onDidMoveEntries = this._onDidMoveEntries.event;

	protected readonly _onDidRemoveEntry = this._register(new Emitter<IWorkingCopyHistoryEvent>());
	readonly onDidRemoveEntry = this._onDidRemoveEntry.event;

	private readonly _onDidRemoveEntries = this._register(new Emitter<void>());
	readonly onDidRemoveEntries = this._onDidRemoveEntries.event;

	private readonly localHistoryHome = new DeferredPromise<URI>();

	protected readonly models = new ResourceMap<WorkingCopyHistoryModel>(resource => this.uriIdentityService.extUri.getComparisonKey(resource));

	constructor(
		@IFileService protected readonly fileService: IFileService,
		@IRemoteAgentService protected readonly remoteAgentService: IRemoteAgentService,
		@IEnvironmentService protected readonly environmentService: IEnvironmentService,
		@IUriIdentityService protected readonly uriIdentityService: IUriIdentityService,
		@ILabelService protected readonly labelService: ILabelService,
		@ILogService protected readonly logService: ILogService,
		@IConfigurationService protected readonly configurationService: IConfigurationService
	) {
		super();

		this.resolveLocalHistoryHome();

		this._register(this.fileService.onDidRunOperation(e => this.onDidRunFileOperation(e)));
	}

	private async resolveLocalHistoryHome(): Promise<void> {
		let historyHome: URI | undefined = undefined;

		// Prefer history to be stored in the remote if we are connected to a remote
		try {
			const remoteEnv = await this.remoteAgentService.getEnvironment();
			if (remoteEnv) {
				historyHome = remoteEnv.localHistoryHome;
			}
		} catch (error) {
			this.logService.trace(error); // ignore and fallback to local
		}

		// But fallback to local if there is no remote
		if (!historyHome) {
			historyHome = this.environmentService.localHistoryHome;
		}

		this.localHistoryHome.complete(historyHome);
	}

	private async onDidRunFileOperation(e: FileOperationEvent): Promise<void> {
		if (!e.isOperation(FileOperation.MOVE)) {
			return; // only interested in move operations
		}

		const source = e.resource;
		const target = e.target.resource;

		const limiter = new Limiter(MAX_PARALLEL_HISTORY_IO_OPS);
		const promises = [];

		for (const [resource, model] of this.models) {
			if (!this.uriIdentityService.extUri.isEqualOrParent(resource, source)) {
				continue; // model does not match moved resource
			}


			// Determine new resulting target resource
			let targetResource: URI;
			if (isEqual(source, resource)) {
				targetResource = target; // file got moved
			} else {
				const index = indexOfPath(resource.path, source.path);
				targetResource = joinPath(target, resource.path.substr(index + source.path.length + 1)); // parent folder got moved
			}

			// Figure out save source
			let saveSource: SaveSource;
			if (isEqual(dirname(resource), dirname(targetResource))) {
				saveSource = WorkingCopyHistoryService.FILE_RENAMED_SOURCE;
			} else {
				saveSource = WorkingCopyHistoryService.FILE_MOVED_SOURCE;
			}

			// Move entries to target queued
			promises.push(limiter.queue(() => this.moveEntries(model, saveSource, resource, targetResource)));
		}

		if (!promises.length) {
			return;
		}

		// Await move operations
		await Promise.all(promises);

		// Events
		this._onDidMoveEntries.fire();
	}

	private async moveEntries(model: WorkingCopyHistoryModel, source: SaveSource, sourceWorkingCopyResource: URI, targetWorkingCopyResource: URI): Promise<void> {

		// Move to target via model
		await model.moveEntries(targetWorkingCopyResource, source, CancellationToken.None);

		// Update model in our map
		this.models.delete(sourceWorkingCopyResource);
		this.models.set(targetWorkingCopyResource, model);
	}

	async addEntry({ resource, source, timestamp }: IWorkingCopyHistoryEntryDescriptor, token: CancellationToken): Promise<IWorkingCopyHistoryEntry | undefined> {
		if (!this.fileService.hasProvider(resource)) {
			return undefined; // we require the working copy resource to be file service accessible
		}

		// Resolve history model for working copy
		const model = await this.getModel(resource);
		if (token.isCancellationRequested) {
			return undefined;
		}

		// Add to model
		return model.addEntry(source, timestamp, token);
	}

	async updateEntry(entry: IWorkingCopyHistoryEntry, properties: { source: SaveSource }, token: CancellationToken): Promise<void> {

		// Resolve history model for working copy
		const model = await this.getModel(entry.workingCopy.resource);
		if (token.isCancellationRequested) {
			return;
		}

		// Rename in model
		return model.updateEntry(entry, properties, token);
	}

	async removeEntry(entry: IWorkingCopyHistoryEntry, token: CancellationToken): Promise<boolean> {

		// Resolve history model for working copy
		const model = await this.getModel(entry.workingCopy.resource);
		if (token.isCancellationRequested) {
			return false;
		}

		// Remove from model
		return model.removeEntry(entry, token);
	}

	async removeAll(token: CancellationToken): Promise<void> {
		const historyHome = await this.localHistoryHome.p;
		if (token.isCancellationRequested) {
			return;
		}

		// Clear models
		this.models.clear();

		// Remove from disk
		await this.fileService.del(historyHome, { recursive: true });

		// Events
		this._onDidRemoveEntries.fire();
	}

	async getEntries(resource: URI, token: CancellationToken): Promise<readonly IWorkingCopyHistoryEntry[]> {
		const model = await this.getModel(resource);
		if (token.isCancellationRequested) {
			return [];
		}

		const entries = await model.getEntries();
		return entries ?? [];
	}

	async getAll(token: CancellationToken): Promise<readonly URI[]> {
		const historyHome = await this.localHistoryHome.p;
		if (token.isCancellationRequested) {
			return [];
		}

		const all = new ResourceMap<true>();

		// Fill in all known model resources (they might not have yet persisted to disk)
		for (const [resource, model] of this.models) {
			const hasInMemoryEntries = await model.hasEntries(true /* skip resolving because we resolve below from disk */);
			if (hasInMemoryEntries) {
				all.set(resource, true);
			}
		}

		// Resolve all other resources by iterating the history home folder
		try {
			const resolvedHistoryHome = await this.fileService.resolve(historyHome);
			if (resolvedHistoryHome.children) {
				const limiter = new Limiter(MAX_PARALLEL_HISTORY_IO_OPS);
				const promises = [];

				for (const child of resolvedHistoryHome.children) {
					promises.push(limiter.queue(async () => {
						if (token.isCancellationRequested) {
							return;
						}

						try {
							const serializedModel: ISerializedWorkingCopyHistoryModel = JSON.parse((await this.fileService.readFile(joinPath(child.resource, WorkingCopyHistoryModel.ENTRIES_FILE))).value.toString());
							if (serializedModel.entries.length > 0) {
								all.set(URI.parse(serializedModel.resource), true);
							}
						} catch (error) {
							// ignore - model might be missing or corrupt, but we need it
						}
					}));
				}

				await Promise.all(promises);
			}
		} catch (error) {
			// ignore - history might be entirely empty
		}

		return Array.from(all.keys());
	}

	private async getModel(resource: URI): Promise<WorkingCopyHistoryModel> {
		const historyHome = await this.localHistoryHome.p;

		let model = this.models.get(resource);
		if (!model) {
			model = this.createModel(resource, historyHome);
			this.models.set(resource, model);
		}

		return model;
	}

	protected createModel(resource: URI, historyHome: URI): WorkingCopyHistoryModel {
		return new WorkingCopyHistoryModel(resource, historyHome, this._onDidAddEntry, this._onDidChangeEntry, this._onDidReplaceEntry, this._onDidRemoveEntry, this.fileService, this.labelService, this.logService, this.configurationService);
	}
}

// Register History Tracker
Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench).registerWorkbenchContribution(WorkingCopyHistoryTracker, LifecyclePhase.Restored);
