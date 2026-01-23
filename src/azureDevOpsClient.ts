import axios, { AxiosInstance } from 'axios';

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
    blocks: DiffBlock[];
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
    private axiosInstance: AxiosInstance;
    private config: AzureDevOpsConfig;
    private repositoryId: string | undefined;

    constructor(config: AzureDevOpsConfig) {
        this.config = config;

        // Create axios instance with basic auth using PAT
        this.axiosInstance = axios.create({
            baseURL: `${config.organizationUrl}/${config.project}/_apis`,
            headers: {
                'Content-Type': 'application/json',
            },
            auth: {
                username: '',
                password: config.pat
            }
        });
    }

    /**
     * Get the repository GUID (required for Build API calls)
     */
    private async getRepositoryId(): Promise<string> {
        if (this.repositoryId) {
            return this.repositoryId;
        }

        try {
            const response = await this.axiosInstance.get(
                `/git/repositories/${this.config.repository}`,
                {
                    params: {
                        'api-version': '7.0'
                    }
                }
            );
            this.repositoryId = response.data.id as string;
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
            const response = await this.axiosInstance.get(
                `/git/repositories/${this.config.repository}/pullrequests`,
                {
                    params: {
                        'api-version': '7.0',
                        'searchCriteria.status': status
                    }
                }
            );
            return response.data.value;
        } catch (error) {
            throw this.handleError(error, 'Failed to fetch pull requests');
        }
    }

    /**
     * Get a specific pull request by ID
     */
    async getPullRequest(pullRequestId: number): Promise<PullRequest> {
        try {
            const response = await this.axiosInstance.get(
                `/git/repositories/${this.config.repository}/pullrequests/${pullRequestId}`,
                {
                    params: {
                        'api-version': '7.0'
                    }
                }
            );
            return response.data;
        } catch (error) {
            throw this.handleError(error, `Failed to fetch pull request ${pullRequestId}`);
        }
    }

    /**
     * Create a new pull request
     */
    async createPullRequest(params: CreatePullRequestParams): Promise<PullRequest> {
        try {
            const response = await this.axiosInstance.post(
                `/git/repositories/${this.config.repository}/pullrequests`,
                {
                    sourceRefName: params.sourceRefName,
                    targetRefName: params.targetRefName,
                    title: params.title,
                    description: params.description
                },
                {
                    params: {
                        'api-version': '7.0'
                    }
                }
            );
            return response.data;
        } catch (error) {
            throw this.handleError(error, 'Failed to create pull request');
        }
    }

    /**
     * Get pipelines associated with a pull request
     */
    async getPullRequestPipelines(pullRequestId: number): Promise<PipelineRun[]> {
        try {
            // Get repository GUID (required by Build API for TfsGit repositories)
            const repoId = await this.getRepositoryId();

            // Get builds associated with the PR
            const response = await this.axiosInstance.get(
                `/build/builds`,
                {
                    params: {
                        'api-version': '7.0',
                        'repositoryId': repoId,
                        'repositoryType': 'TfsGit'
                    }
                }
            );

            // Filter builds related to the PR
            const builds = response.data.value;
            const prBuilds = builds.filter((build: any) => {
                return build.triggerInfo &&
                       build.triggerInfo['pr.number'] === pullRequestId.toString();
            });

            return prBuilds.map((build: any) => ({
                id: build.id,
                name: build.definition.name,
                state: build.status,
                result: build.result || 'pending',
                createdDate: build.queueTime,
                finishedDate: build.finishTime,
                url: build._links.web.href
            }));
        } catch (error) {
            throw this.handleError(error, `Failed to fetch pipelines for PR ${pullRequestId}`);
        }
    }

    /**
     * Get all pipelines in the project
     */
    async getPipelines(): Promise<Pipeline[]> {
        try {
            const response = await this.axiosInstance.get(
                `/build/definitions`,
                {
                    params: {
                        'api-version': '7.0'
                    }
                }
            );
            return response.data.value.map((pipeline: any) => ({
                id: pipeline.id,
                name: pipeline.name,
                url: pipeline._links.web.href
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
            const response = await this.axiosInstance.get(
                `/build/builds`,
                {
                    params: {
                        'api-version': '7.0',
                        'definitions': pipelineId,
                        '$top': top
                    }
                }
            );

            return response.data.value.map((build: any) => ({
                id: build.id,
                name: build.definition.name,
                state: build.status,
                result: build.result || 'pending',
                createdDate: build.queueTime,
                finishedDate: build.finishTime,
                url: build._links.web.href
            }));
        } catch (error) {
            throw this.handleError(error, `Failed to fetch runs for pipeline ${pipelineId}`);
        }
    }

    /**
     * Get repository branches
     */
    async getBranches(): Promise<string[]> {
        try {
            const response = await this.axiosInstance.get(
                `/git/repositories/${this.config.repository}/refs`,
                {
                    params: {
                        'api-version': '7.0',
                        'filter': 'heads/'
                    }
                }
            );
            return response.data.value.map((ref: any) => ref.name);
        } catch (error) {
            throw this.handleError(error, 'Failed to fetch branches');
        }
    }

    /**
     * Get pull request changes (file diffs)
     */
    async getPullRequestChanges(pullRequestId: number): Promise<PullRequestChange[]> {
        try {
            // First get the iterations to find the latest one
            const iterationsResponse = await this.axiosInstance.get(
                `/git/repositories/${this.config.repository}/pullrequests/${pullRequestId}/iterations`,
                {
                    params: {
                        'api-version': '7.0'
                    }
                }
            );

            const iterations = iterationsResponse.data.value;
            if (iterations.length === 0) {
                return [];
            }

            // Get the latest iteration
            const latestIteration = iterations[iterations.length - 1];

            // Get changes for the latest iteration
            const changesResponse = await this.axiosInstance.get(
                `/git/repositories/${this.config.repository}/pullrequests/${pullRequestId}/iterations/${latestIteration.id}/changes`,
                {
                    params: {
                        'api-version': '7.0'
                    }
                }
            );

            return changesResponse.data.changeEntries || [];
        } catch (error) {
            throw this.handleError(error, `Failed to fetch changes for PR ${pullRequestId}`);
        }
    }

    /**
     * Get detailed file diffs for a pull request using Git diff API
     */
    async getPullRequestDiffs(pullRequestId: number): Promise<FileDiff[]> {
        try {
            // Get the pull request details
            const prResponse = await this.axiosInstance.get(
                `/git/repositories/${this.config.repository}/pullrequests/${pullRequestId}`,
                {
                    params: {
                        'api-version': '7.1-preview.1'
                    }
                }
            );

            const pr = prResponse.data;

            // Use the source and target refs directly
            const sourceRef = pr.sourceRefName;
            const targetRef = pr.targetRefName;

            if (!sourceRef || !targetRef) {
                return [];
            }

            // Get the diff between target and source branches
            const diffResponse = await this.axiosInstance.get(
                `/git/repositories/${this.config.repository}/diffs/commits`,
                {
                    params: {
                        'api-version': '7.1-preview.1',
                        'baseVersion': targetRef.replace('refs/heads/', ''),
                        'baseVersionType': 'branch',
                        'targetVersion': sourceRef.replace('refs/heads/', ''),
                        'targetVersionType': 'branch',
                        'diffCommonCommit': true
                    }
                }
            );

            const changes = diffResponse.data.changes || [];
            const fileDiffs: FileDiff[] = [];

            // Process each file change
            for (const change of changes) {
                if (!change.item || change.item.isFolder) {
                    continue;
                }

                // Get the actual diff for this file
                const filePath = change.item.path;
                const blocks: DiffBlock[] = [];

                try {
                    // Fetch file content from both versions for comparison
                    const baseVersionParams = {
                        'api-version': '7.0',
                        'path': filePath,
                        'versionDescriptor.version': targetRef.replace('refs/heads/', ''),
                        'versionDescriptor.versionType': 'branch',
                        '$format': 'text'
                    };

                    const targetVersionParams = {
                        'api-version': '7.0',
                        'path': filePath,
                        'versionDescriptor.version': sourceRef.replace('refs/heads/', ''),
                        'versionDescriptor.versionType': 'branch',
                        '$format': 'text'
                    };

                    let baseContent = '';
                    let targetContent = '';

                    // Fetch base version (target branch)
                    if (change.changeType !== 'add') {
                        try {
                            const baseResponse = await this.axiosInstance.get(
                                `/git/repositories/${this.config.repository}/items`,
                                { params: baseVersionParams }
                            );
                            baseContent = baseResponse.data || '';
                        } catch {
                            baseContent = '';
                        }
                    }

                    // Fetch target version (source branch)
                    if (change.changeType !== 'delete') {
                        try {
                            const targetResponse = await this.axiosInstance.get(
                                `/git/repositories/${this.config.repository}/items`,
                                { params: targetVersionParams }
                            );
                            targetContent = targetResponse.data || '';
                        } catch {
                            targetContent = '';
                        }
                    }

                    // Generate diff lines
                    const diffLines = this.generateDiff(baseContent, targetContent);
                    if (diffLines.length > 0) {
                        blocks.push({
                            changeType: change.changeType,
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
                    changeType: change.changeType,
                    blocks
                });
            }

            return fileDiffs;
        } catch (error) {
            throw this.handleError(error, `Failed to fetch diffs for PR ${pullRequestId}`);
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

    private getChangeTypeString(changeType: number): string {
        switch (changeType) {
            case 1: return 'delete';
            case 2: return 'add';
            case 3: return 'edit';
            default: return 'none';
        }
    }

    private handleError(error: any, message: string): Error {
        if (axios.isAxiosError(error)) {
            const details = error.response?.data?.message || error.message;
            return new Error(`${message}: ${details}`);
        }
        return new Error(`${message}: ${error.message || 'Unknown error'}`);
    }
}
