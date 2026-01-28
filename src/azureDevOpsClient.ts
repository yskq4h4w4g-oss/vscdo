import * as azdev from 'azure-devops-node-api';
import * as GitApi from 'azure-devops-node-api/GitApi';
import * as BuildApi from 'azure-devops-node-api/BuildApi';
import { GitPullRequest, GitPullRequestSearchCriteria, PullRequestStatus, GitRef, VersionControlChangeType, GitVersionDescriptor, GitVersionType, IdentityRefWithVote, GitPullRequestCommentThread, Comment as GitComment, CommentThreadStatus, CommentType } from 'azure-devops-node-api/interfaces/GitInterfaces';
import { Build, BuildDefinitionReference, BuildStatus, BuildResult } from 'azure-devops-node-api/interfaces/BuildInterfaces';

export interface AzureDevOpsConfig {
    organizationUrl: string;
    project: string;
    repository: string;
    pat: string;
}

export interface Reviewer {
    id: string;
    displayName: string;
    uniqueName: string;
    imageUrl: string;
    vote: number;
    isRequired: boolean;
    hasDeclined: boolean;
    isFlagged: boolean;
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
    reviewers: Reviewer[];
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

export interface CurrentUser {
    id: string;
    displayName: string;
    uniqueName: string;
}

export interface CommentThread {
    id: number;
    status: string;
    comments: PRComment[];
    threadContext?: {
        filePath: string;
        rightFileStart?: { line: number; offset: number };
        rightFileEnd?: { line: number; offset: number };
        leftFileStart?: { line: number; offset: number };
        leftFileEnd?: { line: number; offset: number };
    };
    isDeleted: boolean;
    publishedDate: string;
    lastUpdatedDate: string;
}

export interface PRComment {
    id: number;
    content: string;
    author: { displayName: string; uniqueName: string };
    publishedDate: string;
    lastUpdatedDate: string;
    isDeleted: boolean;
    commentType: string;
}

export class AzureDevOpsClient {
    private connection: azdev.WebApi;
    private config: AzureDevOpsConfig;
    private gitApi: GitApi.IGitApi | undefined;
    private buildApi: BuildApi.IBuildApi | undefined;
    private repositoryId: string | undefined;
    private currentUser: CurrentUser | undefined;

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
     * Get the current authenticated user
     */
    async getCurrentUser(): Promise<CurrentUser> {
        if (this.currentUser) {
            return this.currentUser;
        }

        try {
            const connectionData = await this.connection.connect();
            const user = connectionData.authenticatedUser;
            if (!user || !user.id) {
                throw new Error('Unable to get authenticated user');
            }
            this.currentUser = {
                id: user.id,
                displayName: user.providerDisplayName || '',
                uniqueName: user.properties?.Account?.$value || ''
            };
            return this.currentUser;
        } catch (error) {
            throw this.handleError(error, 'Failed to get current user');
        }
    }

    /**
     * Vote on a pull request
     * @param pullRequestId The ID of the pull request
     * @param vote The vote value: 10 (approve), 5 (approve with suggestions), 0 (reset), -5 (wait for author), -10 (reject)
     */
    async votePullRequest(pullRequestId: number, vote: number): Promise<Reviewer> {
        try {
            const gitApi = await this.getGitApi();
            const currentUser = await this.getCurrentUser();

            const reviewer: IdentityRefWithVote = {
                vote: vote
            };

            const result = await gitApi.createPullRequestReviewer(
                reviewer,
                this.config.repository,
                pullRequestId,
                currentUser.id,
                this.config.project
            );

            return this.mapReviewer(result);
        } catch (error) {
            throw this.handleError(error, `Failed to vote on pull request ${pullRequestId}`);
        }
    }

    /**
     * Get all comment threads for a pull request
     */
    async getCommentThreads(pullRequestId: number): Promise<CommentThread[]> {
        try {
            const gitApi = await this.getGitApi();
            const threads = await gitApi.getThreads(
                this.config.repository,
                pullRequestId,
                this.config.project
            );

            return (threads || []).map(thread => this.mapCommentThread(thread));
        } catch (error) {
            throw this.handleError(error, `Failed to fetch comment threads for PR ${pullRequestId}`);
        }
    }

    /**
     * Create a new comment thread on a pull request
     * @param pullRequestId The ID of the pull request
     * @param content The comment content
     * @param filePath The file path for the comment
     * @param line The line number
     * @param side 'right' for modified file (source branch), 'left' for original file (target branch)
     */
    async createCommentThread(
        pullRequestId: number,
        content: string,
        filePath: string,
        line: number,
        side: 'left' | 'right'
    ): Promise<CommentThread> {
        try {
            const gitApi = await this.getGitApi();

            const threadContext = side === 'right'
                ? {
                    filePath: filePath,
                    rightFileStart: { line: line, offset: 1 },
                    rightFileEnd: { line: line, offset: 1 }
                }
                : {
                    filePath: filePath,
                    leftFileStart: { line: line, offset: 1 },
                    leftFileEnd: { line: line, offset: 1 }
                };

            const thread: GitPullRequestCommentThread = {
                comments: [
                    {
                        content: content,
                        commentType: CommentType.Text
                    }
                ],
                status: CommentThreadStatus.Active,
                threadContext: threadContext
            };

            const result = await gitApi.createThread(
                thread,
                this.config.repository,
                pullRequestId,
                this.config.project
            );

            return this.mapCommentThread(result);
        } catch (error) {
            throw this.handleError(error, `Failed to create comment thread on PR ${pullRequestId}`);
        }
    }

    /**
     * Reply to an existing comment thread
     * @param pullRequestId The ID of the pull request
     * @param threadId The ID of the thread to reply to
     * @param content The reply content
     */
    async replyToThread(
        pullRequestId: number,
        threadId: number,
        content: string
    ): Promise<PRComment> {
        try {
            const gitApi = await this.getGitApi();

            const comment: GitComment = {
                content: content,
                commentType: CommentType.Text
            };

            const result = await gitApi.createComment(
                comment,
                this.config.repository,
                pullRequestId,
                threadId,
                this.config.project
            );

            return this.mapComment(result);
        } catch (error) {
            throw this.handleError(error, `Failed to reply to thread ${threadId}`);
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
            url: pr._links?.web?.href || '',
            reviewers: (pr.reviewers || []).map(r => this.mapReviewer(r))
        };
    }

    /**
     * Map IdentityRefWithVote to our Reviewer interface
     */
    private mapReviewer(reviewer: IdentityRefWithVote): Reviewer {
        return {
            id: reviewer.id || '',
            displayName: reviewer.displayName || '',
            uniqueName: reviewer.uniqueName || '',
            imageUrl: reviewer.imageUrl || '',
            vote: reviewer.vote || 0,
            isRequired: reviewer.isRequired || false,
            hasDeclined: reviewer.hasDeclined || false,
            isFlagged: reviewer.isFlagged || false
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

    /**
     * Map GitPullRequestCommentThread to our CommentThread interface
     */
    private mapCommentThread(thread: GitPullRequestCommentThread): CommentThread {
        return {
            id: thread.id || 0,
            status: this.mapThreadStatus(thread.status),
            comments: (thread.comments || []).map(c => this.mapComment(c)),
            threadContext: thread.threadContext ? {
                filePath: thread.threadContext.filePath || '',
                rightFileStart: thread.threadContext.rightFileStart ? {
                    line: thread.threadContext.rightFileStart.line || 0,
                    offset: thread.threadContext.rightFileStart.offset || 0
                } : undefined,
                rightFileEnd: thread.threadContext.rightFileEnd ? {
                    line: thread.threadContext.rightFileEnd.line || 0,
                    offset: thread.threadContext.rightFileEnd.offset || 0
                } : undefined,
                leftFileStart: thread.threadContext.leftFileStart ? {
                    line: thread.threadContext.leftFileStart.line || 0,
                    offset: thread.threadContext.leftFileStart.offset || 0
                } : undefined,
                leftFileEnd: thread.threadContext.leftFileEnd ? {
                    line: thread.threadContext.leftFileEnd.line || 0,
                    offset: thread.threadContext.leftFileEnd.offset || 0
                } : undefined
            } : undefined,
            isDeleted: thread.isDeleted || false,
            publishedDate: thread.publishedDate?.toISOString() || '',
            lastUpdatedDate: thread.lastUpdatedDate?.toISOString() || ''
        };
    }

    /**
     * Map Comment to our PRComment interface
     */
    private mapComment(comment: GitComment): PRComment {
        return {
            id: comment.id || 0,
            content: comment.content || '',
            author: {
                displayName: comment.author?.displayName || '',
                uniqueName: comment.author?.uniqueName || ''
            },
            publishedDate: comment.publishedDate?.toISOString() || '',
            lastUpdatedDate: comment.lastUpdatedDate?.toISOString() || '',
            isDeleted: comment.isDeleted || false,
            commentType: this.mapCommentType(comment.commentType)
        };
    }

    /**
     * Map CommentThreadStatus enum to string
     */
    private mapThreadStatus(status: CommentThreadStatus | undefined): string {
        switch (status) {
            case CommentThreadStatus.Active:
                return 'active';
            case CommentThreadStatus.Fixed:
                return 'fixed';
            case CommentThreadStatus.WontFix:
                return 'wontFix';
            case CommentThreadStatus.Closed:
                return 'closed';
            case CommentThreadStatus.ByDesign:
                return 'byDesign';
            case CommentThreadStatus.Pending:
                return 'pending';
            default:
                return 'unknown';
        }
    }

    /**
     * Map CommentType enum to string
     */
    private mapCommentType(type: CommentType | undefined): string {
        switch (type) {
            case CommentType.Text:
                return 'text';
            case CommentType.CodeChange:
                return 'codeChange';
            case CommentType.System:
                return 'system';
            default:
                return 'unknown';
        }
    }
}
