import * as azdev from 'azure-devops-node-api';
import * as GitApi from 'azure-devops-node-api/GitApi';
import * as BuildApi from 'azure-devops-node-api/BuildApi';
import { GitPullRequest, GitPullRequestSearchCriteria, PullRequestStatus, GitRef, VersionControlChangeType, GitVersionDescriptor, GitVersionType } from 'azure-devops-node-api/interfaces/GitInterfaces';
import { Build, BuildDefinitionReference, BuildStatus, BuildResult } from 'azure-devops-node-api/interfaces/BuildInterfaces';

export interface AzureDevOpsConfig {
    organizationUrl: string;
    project: string;
    repository: string;
    pat: string;
}

export interface PullRequest {
    pullRequestId: number;
    title: string;
    description: string;
    sourceRefName: string;
    targetRefName: string;
    status: string;
    createdBy: {
        displayName: string;
        uniqueName: string;
    };
    creationDate: string;
    url: string;
}

export interface Pipeline {
    id: number;
    name: string;
    url: string;
}

export interface PipelineRun {
    id: number;
    name: string;
    state: string;
    result: string;
    createdDate: string;
    finishedDate: string;
    url: string;
}

export interface CreatePullRequestParams {
    sourceRefName: string;
    targetRefName: string;
    title: string;
    description: string;
}

export interface FileChange {
    changeType: string;
    item: {
        path: string;
    };
}

export interface PullRequestChange {
    changeId: number;
    changeType: string;
    item: {
        path: string;
    };
}

export interface FileDiff {
    path: string;
    changeType: string;
    originalContent: string;
    modifiedContent: string;
    blocks: DiffBlock[];
}

export interface FileInfo {
    path: string;
    changeType: string;
}

export interface DiffBlock {
    changeType: string;
    mLine: number;
    mLinesCount: number;
    oLine: number;
    oLinesCount: number;
    lines: DiffLine[];
}

export interface DiffLine {
    line: string;
    lineType: 'added' | 'deleted' | 'unchanged';
    oLine?: number;
    mLine?: number;
}

export class AzureDevOpsClient {
    private connection: azdev.WebApi;
    private config: AzureDevOpsConfig;
    private gitApi: GitApi.IGitApi | undefined;
    private buildApi: BuildApi.IBuildApi | undefined;
    private repositoryId: string | undefined;

    constructor(config: AzureDevOpsConfig) {
        this.config = config;

        // Create connection using PAT authentication
        const authHandler = azdev.getPersonalAccessTokenHandler(config.pat);
        this.connection = new azdev.WebApi(config.organizationUrl, authHandler);
    }

    /**
     * Get the Git API client
     */
    private async getGitApi(): Promise<GitApi.IGitApi> {
        if (!this.gitApi) {
            this.gitApi = await this.connection.getGitApi();
        }
        return this.gitApi;
    }

    /**
     * Get the Build API client
     */
    private async getBuildApi(): Promise<BuildApi.IBuildApi> {
        if (!this.buildApi) {
            this.buildApi = await this.connection.getBuildApi();
        }
        return this.buildApi;
    }

    /**
     * Get the repository GUID (required for Build API calls)
     */
    private async getRepositoryId(): Promise<string> {
        if (this.repositoryId) {
            return this.repositoryId;
        }

        try {
            const gitApi = await this.getGitApi();
            const repo = await gitApi.getRepository(this.config.repository, this.config.project);
            if (!repo || !repo.id) {
                throw new Error('Repository not found');
            }
            this.repositoryId = repo.id;
            return this.repositoryId;
        } catch (error) {
            throw this.handleError(error, 'Failed to fetch repository details');
        }
    }

    /**
     * Get all pull requests for the repository
     */
    async getPullRequests(status: 'active' | 'completed' | 'all' = 'active'): Promise<PullRequest[]> {
        try {
            const gitApi = await this.getGitApi();

            const searchCriteria: GitPullRequestSearchCriteria = {
                status: this.mapStatusToEnum(status)
            };

            const prs = await gitApi.getPullRequests(
                this.config.repository,
                searchCriteria,
                this.config.project
            );

            return (prs || []).map(pr => this.mapPullRequest(pr));
        } catch (error) {
            throw this.handleError(error, 'Failed to fetch pull requests');
        }
    }

    /**
     * Get a specific pull request by ID
     */
    async getPullRequest(pullRequestId: number): Promise<PullRequest> {
        try {
            const gitApi = await this.getGitApi();
            const pr = await gitApi.getPullRequest(
                this.config.repository,
                pullRequestId,
                this.config.project
            );
            return this.mapPullRequest(pr);
        } catch (error) {
            throw this.handleError(error, `Failed to fetch pull request ${pullRequestId}`);
        }
    }

    /**
     * Create a new pull request
     */
    async createPullRequest(params: CreatePullRequestParams): Promise<PullRequest> {
        try {
            const gitApi = await this.getGitApi();

            const prToCreate: GitPullRequest = {
                sourceRefName: params.sourceRefName,
                targetRefName: params.targetRefName,
                title: params.title,
                description: params.description
            };

            const pr = await gitApi.createPullRequest(
                prToCreate,
                this.config.repository,
                this.config.project
            );

            return this.mapPullRequest(pr);
        } catch (error) {
            throw this.handleError(error, 'Failed to create pull request');
        }
    }

    /**
     * Get pipelines associated with a pull request
     */
    async getPullRequestPipelines(pullRequestId: number): Promise<PipelineRun[]> {
        try {
            const buildApi = await this.getBuildApi();
            const repoId = await this.getRepositoryId();

            const builds = await buildApi.getBuilds(
                this.config.project,
                undefined, // definitions
                undefined, // queues
                undefined, // buildNumber
                undefined, // minTime
                undefined, // maxTime
                undefined, // requestedFor
                undefined, // reasonFilter
                undefined, // statusFilter
                undefined, // resultFilter
                undefined, // tagFilters
                undefined, // properties
                undefined, // top
                undefined, // continuationToken
                undefined, // maxBuildsPerDefinition
                undefined, // deletedFilter
                undefined, // queryOrder
                undefined, // branchName
                undefined, // buildIds
                repoId,    // repositoryId
                'TfsGit'   // repositoryType
            );

            // Filter builds related to the PR
            const prBuilds = (builds || []).filter((build: Build) => {
                return build.triggerInfo &&
                       build.triggerInfo['pr.number'] === pullRequestId.toString();
            });

            return prBuilds.map((build: Build) => this.mapBuildToRun(build));
        } catch (error) {
            throw this.handleError(error, `Failed to fetch pipelines for PR ${pullRequestId}`);
        }
    }

    /**
     * Get all pipelines in the project
     */
    async getPipelines(): Promise<Pipeline[]> {
        try {
            const buildApi = await this.getBuildApi();
            const definitions = await buildApi.getDefinitions(this.config.project);

            return (definitions || []).map((def: BuildDefinitionReference) => ({
                id: def.id!,
                name: def.name || '',
                url: def._links?.web?.href || ''
            }));
        } catch (error) {
            throw this.handleError(error, 'Failed to fetch pipelines');
        }
    }

    /**
     * Get recent runs for a specific pipeline
     */
    async getPipelineRuns(pipelineId: number, top: number = 10): Promise<PipelineRun[]> {
        try {
            const buildApi = await this.getBuildApi();

            const builds = await buildApi.getBuilds(
                this.config.project,
                [pipelineId], // definitions
                undefined,    // queues
                undefined,    // buildNumber
                undefined,    // minTime
                undefined,    // maxTime
                undefined,    // requestedFor
                undefined,    // reasonFilter
                undefined,    // statusFilter
                undefined,    // resultFilter
                undefined,    // tagFilters
                undefined,    // properties
                top           // top
            );

            return (builds || []).map((build: Build) => this.mapBuildToRun(build));
        } catch (error) {
            throw this.handleError(error, `Failed to fetch runs for pipeline ${pipelineId}`);
        }
    }

    /**
     * Get repository branches
     */
    async getBranches(): Promise<string[]> {
        try {
            const gitApi = await this.getGitApi();
            const refs = await gitApi.getRefs(
                this.config.repository,
                this.config.project,
                'heads/'
            );

            return (refs || []).map((ref: GitRef) => ref.name || '');
        } catch (error) {
            throw this.handleError(error, 'Failed to fetch branches');
        }
    }

    /**
     * Get pull request changes (file diffs)
     */
    async getPullRequestChanges(pullRequestId: number): Promise<PullRequestChange[]> {
        try {
            const gitApi = await this.getGitApi();

            // First get the iterations to find the latest one
            const iterations = await gitApi.getPullRequestIterations(
                this.config.repository,
                pullRequestId,
                this.config.project
            );

            if (!iterations || iterations.length === 0) {
                return [];
            }

            // Get the latest iteration
            const latestIteration = iterations[iterations.length - 1];

            // Get changes for the latest iteration
            const changes = await gitApi.getPullRequestIterationChanges(
                this.config.repository,
                pullRequestId,
                latestIteration.id!,
                this.config.project
            );

            return (changes?.changeEntries || []).map((entry: any) => ({
                changeId: entry.changeId || 0,
                changeType: this.mapChangeType(entry.changeType),
                item: {
                    path: entry.item?.path || ''
                }
            }));
        } catch (error) {
            throw this.handleError(error, `Failed to fetch changes for PR ${pullRequestId}`);
        }
    }

    /**
     * Get list of changed files for a pull request (fast - no content fetching)
     */
    async getPullRequestFileList(pullRequestId: number): Promise<{ files: FileInfo[], sourceRef: string, targetRef: string }> {
        try {
            const gitApi = await this.getGitApi();

            // Get the pull request details
            const pr = await gitApi.getPullRequest(
                this.config.repository,
                pullRequestId,
                this.config.project
            );

            const sourceRef = pr.sourceRefName;
            const targetRef = pr.targetRefName;

            if (!sourceRef || !targetRef) {
                return { files: [], sourceRef: '', targetRef: '' };
            }

            // Get the diff between target and source branches
            const baseVersionDescriptor: GitVersionDescriptor = {
                version: targetRef.replace('refs/heads/', ''),
                versionType: GitVersionType.Branch
            };
            const targetVersionDescriptor: GitVersionDescriptor = {
                version: sourceRef.replace('refs/heads/', ''),
                versionType: GitVersionType.Branch
            };

            const diffResult = await gitApi.getCommitDiffs(
                this.config.repository,
                this.config.project,
                true, // diffCommonCommit
                undefined, // top
                undefined, // skip
                baseVersionDescriptor,
                targetVersionDescriptor
            );

            const changes = diffResult?.changes || [];
            const files: FileInfo[] = [];

            for (const change of changes) {
                if (!change.item || change.item.isFolder) {
                    continue;
                }

                files.push({
                    path: change.item.path || '',
                    changeType: this.mapChangeType(change.changeType)
                });
            }

            return {
                files,
                sourceRef: sourceRef.replace('refs/heads/', ''),
                targetRef: targetRef.replace('refs/heads/', '')
            };
        } catch (error) {
            throw this.handleError(error, `Failed to fetch file list for PR ${pullRequestId}`);
        }
    }

    /**
     * Get diff content for a single file
     */
    async getFileDiff(filePath: string, changeType: string, sourceRef: string, targetRef: string): Promise<FileDiff> {
        try {
            const gitApi = await this.getGitApi();

            const baseVersionDescriptor: GitVersionDescriptor = {
                version: targetRef,
                versionType: GitVersionType.Branch
            };
            const targetVersionDescriptor: GitVersionDescriptor = {
                version: sourceRef,
                versionType: GitVersionType.Branch
            };

            let baseContent = '';
            let targetContent = '';

            // Fetch base version (target branch) - skip for new files
            if (changeType !== 'add') {
                try {
                    const baseItem = await gitApi.getItemContent(
                        this.config.repository,
                        filePath,
                        this.config.project,
                        undefined, // scopePath
                        undefined, // recursionLevel
                        undefined, // includeContentMetadata
                        undefined, // latestProcessedChange
                        undefined, // download
                        baseVersionDescriptor
                    );
                    baseContent = await this.streamToString(baseItem);
                } catch {
                    baseContent = '';
                }
            }

            // Fetch target version (source branch) - skip for deleted files
            if (changeType !== 'delete') {
                try {
                    const targetItem = await gitApi.getItemContent(
                        this.config.repository,
                        filePath,
                        this.config.project,
                        undefined, // scopePath
                        undefined, // recursionLevel
                        undefined, // includeContentMetadata
                        undefined, // latestProcessedChange
                        undefined, // download
                        targetVersionDescriptor
                    );
                    targetContent = await this.streamToString(targetItem);
                } catch {
                    targetContent = '';
                }
            }

            // Generate diff lines
            const diffLines = this.generateDiff(baseContent, targetContent);
            const blocks: DiffBlock[] = [];

            if (diffLines.length > 0) {
                blocks.push({
                    changeType: changeType,
                    mLine: 0,
                    mLinesCount: diffLines.filter(l => l.lineType === 'added').length,
                    oLine: 0,
                    oLinesCount: diffLines.filter(l => l.lineType === 'deleted').length,
                    lines: diffLines
                });
            }

            return {
                path: filePath,
                changeType: changeType,
                originalContent: baseContent,
                modifiedContent: targetContent,
                blocks
            };
        } catch (error) {
            throw this.handleError(error, `Failed to fetch diff for ${filePath}`);
        }
    }

    /**
     * Get detailed file diffs for a pull request using Git diff API
     */
    async getPullRequestDiffs(pullRequestId: number): Promise<FileDiff[]> {
        try {
            const gitApi = await this.getGitApi();

            // Get the pull request details
            const pr = await gitApi.getPullRequest(
                this.config.repository,
                pullRequestId,
                this.config.project
            );

            const sourceRef = pr.sourceRefName;
            const targetRef = pr.targetRefName;

            if (!sourceRef || !targetRef) {
                return [];
            }

            // Get the diff between target and source branches
            const baseVersionDescriptor: GitVersionDescriptor = {
                version: targetRef.replace('refs/heads/', ''),
                versionType: GitVersionType.Branch
            };
            const targetVersionDescriptor: GitVersionDescriptor = {
                version: sourceRef.replace('refs/heads/', ''),
                versionType: GitVersionType.Branch
            };

            const diffResult = await gitApi.getCommitDiffs(
                this.config.repository,
                this.config.project,
                true, // diffCommonCommit
                undefined, // top
                undefined, // skip
                baseVersionDescriptor,
                targetVersionDescriptor
            );

            const changes = diffResult?.changes || [];
            const fileDiffs: FileDiff[] = [];

            // Process each file change
            for (const change of changes) {
                if (!change.item || change.item.isFolder) {
                    continue;
                }

                const filePath = change.item.path || '';
                const blocks: DiffBlock[] = [];
                const changeType = this.mapChangeType(change.changeType);

                let baseContent = '';
                let targetContent = '';

                try {
                    // Fetch base version (target branch)
                    if (changeType !== 'add') {
                        try {
                            const baseItem = await gitApi.getItemContent(
                                this.config.repository,
                                filePath,
                                this.config.project,
                                undefined, // scopePath
                                undefined, // recursionLevel
                                undefined, // includeContentMetadata
                                undefined, // latestProcessedChange
                                undefined, // download
                                baseVersionDescriptor
                            );
                            baseContent = await this.streamToString(baseItem);
                        } catch {
                            baseContent = '';
                        }
                    }

                    // Fetch target version (source branch)
                    if (changeType !== 'delete') {
                        try {
                            const targetItem = await gitApi.getItemContent(
                                this.config.repository,
                                filePath,
                                this.config.project,
                                undefined, // scopePath
                                undefined, // recursionLevel
                                undefined, // includeContentMetadata
                                undefined, // latestProcessedChange
                                undefined, // download
                                targetVersionDescriptor
                            );
                            targetContent = await this.streamToString(targetItem);
                        } catch {
                            targetContent = '';
                        }
                    }

                    // Generate diff lines
                    const diffLines = this.generateDiff(baseContent, targetContent);
                    if (diffLines.length > 0) {
                        blocks.push({
                            changeType: changeType,
                            mLine: 0,
                            mLinesCount: diffLines.filter(l => l.lineType === 'added').length,
                            oLine: 0,
                            oLinesCount: diffLines.filter(l => l.lineType === 'deleted').length,
                            lines: diffLines
                        });
                    }
                } catch (fileError) {
                    console.error(`Failed to fetch diff for ${filePath}:`, fileError);
                }

                fileDiffs.push({
                    path: filePath,
                    changeType: changeType,
                    originalContent: baseContent,
                    modifiedContent: targetContent,
                    blocks
                });
            }

            return fileDiffs;
        } catch (error) {
            throw this.handleError(error, `Failed to fetch diffs for PR ${pullRequestId}`);
        }
    }

    /**
     * Convert a readable stream to string
     */
    private async streamToString(stream: NodeJS.ReadableStream): Promise<string> {
        const chunks: Buffer[] = [];
        return new Promise((resolve, reject) => {
            stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
            stream.on('error', (err) => reject(err));
            stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        });
    }

    /**
     * Map status string to PullRequestStatus enum
     */
    private mapStatusToEnum(status: 'active' | 'completed' | 'all'): PullRequestStatus {
        switch (status) {
            case 'active':
                return PullRequestStatus.Active;
            case 'completed':
                return PullRequestStatus.Completed;
            case 'all':
                return PullRequestStatus.All;
            default:
                return PullRequestStatus.Active;
        }
    }

    /**
     * Map GitPullRequest to our PullRequest interface
     */
    private mapPullRequest(pr: GitPullRequest): PullRequest {
        return {
            pullRequestId: pr.pullRequestId || 0,
            title: pr.title || '',
            description: pr.description || '',
            sourceRefName: pr.sourceRefName || '',
            targetRefName: pr.targetRefName || '',
            status: this.mapPullRequestStatus(pr.status),
            createdBy: {
                displayName: pr.createdBy?.displayName || '',
                uniqueName: pr.createdBy?.uniqueName || ''
            },
            creationDate: pr.creationDate?.toISOString() || '',
            url: pr._links?.web?.href || ''
        };
    }

    /**
     * Map PullRequestStatus enum to string
     */
    private mapPullRequestStatus(status: PullRequestStatus | undefined): string {
        switch (status) {
            case PullRequestStatus.Active:
                return 'active';
            case PullRequestStatus.Completed:
                return 'completed';
            case PullRequestStatus.Abandoned:
                return 'abandoned';
            case PullRequestStatus.NotSet:
                return 'notSet';
            default:
                return 'unknown';
        }
    }

    /**
     * Map Build to PipelineRun interface
     */
    private mapBuildToRun(build: Build): PipelineRun {
        return {
            id: build.id || 0,
            name: build.definition?.name || '',
            state: this.mapBuildStatus(build.status),
            result: this.mapBuildResult(build.result),
            createdDate: build.queueTime?.toISOString() || '',
            finishedDate: build.finishTime?.toISOString() || '',
            url: build._links?.web?.href || ''
        };
    }

    /**
     * Map BuildStatus enum to string
     */
    private mapBuildStatus(status: BuildStatus | undefined): string {
        switch (status) {
            case BuildStatus.None:
                return 'none';
            case BuildStatus.InProgress:
                return 'inProgress';
            case BuildStatus.Completed:
                return 'completed';
            case BuildStatus.Cancelling:
                return 'cancelling';
            case BuildStatus.Postponed:
                return 'postponed';
            case BuildStatus.NotStarted:
                return 'notStarted';
            case BuildStatus.All:
                return 'all';
            default:
                return 'unknown';
        }
    }

    /**
     * Map BuildResult enum to string
     */
    private mapBuildResult(result: BuildResult | undefined): string {
        switch (result) {
            case BuildResult.None:
                return 'pending';
            case BuildResult.Succeeded:
                return 'succeeded';
            case BuildResult.PartiallySucceeded:
                return 'partiallySucceeded';
            case BuildResult.Failed:
                return 'failed';
            case BuildResult.Canceled:
                return 'canceled';
            default:
                return 'pending';
        }
    }

    /**
     * Map VersionControlChangeType to string
     */
    private mapChangeType(changeType: VersionControlChangeType | undefined): string {
        switch (changeType) {
            case VersionControlChangeType.Add:
                return 'add';
            case VersionControlChangeType.Edit:
                return 'edit';
            case VersionControlChangeType.Delete:
                return 'delete';
            case VersionControlChangeType.Rename:
                return 'rename';
            default:
                return 'none';
        }
    }

    /**
     * Generate diff lines by comparing two file contents
     */
    private generateDiff(baseContent: string, targetContent: string): DiffLine[] {
        const lines: DiffLine[] = [];
        const baseLines = baseContent.split('\n');
        const targetLines = targetContent.split('\n');

        // Simple line-by-line diff
        const maxLines = Math.max(baseLines.length, targetLines.length);

        for (let i = 0; i < maxLines; i++) {
            const baseLine = i < baseLines.length ? baseLines[i] : null;
            const targetLine = i < targetLines.length ? targetLines[i] : null;

            if (baseLine === targetLine && baseLine !== null) {
                // Unchanged line - only show first and last few for context
                if (i < 3 || i >= maxLines - 3) {
                    lines.push({
                        line: baseLine,
                        lineType: 'unchanged',
                        oLine: i + 1,
                        mLine: i + 1
                    });
                }
            } else {
                // Changed lines
                if (baseLine !== null && (targetLine === null || baseLine !== targetLine)) {
                    lines.push({
                        line: baseLine,
                        lineType: 'deleted',
                        oLine: i + 1
                    });
                }
                if (targetLine !== null && (baseLine === null || baseLine !== targetLine)) {
                    lines.push({
                        line: targetLine,
                        lineType: 'added',
                        mLine: i + 1
                    });
                }
            }
        }

        return lines;
    }

    private handleError(error: any, message: string): Error {
        const errorMessage = error?.message || error?.toString() || 'Unknown error';
        return new Error(`${message}: ${errorMessage}`);
    }
}
