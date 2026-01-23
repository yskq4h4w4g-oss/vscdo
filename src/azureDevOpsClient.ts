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

    private handleError(error: any, message: string): Error {
        if (axios.isAxiosError(error)) {
            const details = error.response?.data?.message || error.message;
            return new Error(`${message}: ${details}`);
        }
        return new Error(`${message}: ${error.message || 'Unknown error'}`);
    }
}
