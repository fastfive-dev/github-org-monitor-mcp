import { Octokit } from "@octokit/rest";
import { AsyncLocalStorage } from "node:async_hooks";
import { TtlCache } from "./utils/cache.js";

// Per-request context store
interface RequestContext {
  token: string;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();

// Cache Octokit instances by token to avoid re-creating per call within same request
const octokitCache = new Map<string, Octokit>();

// Response caches (5 min TTL)
const contributorStatsCache = new TtlCache<ContributorStats[]>(5 * 60 * 1000);
const orgReposCache = new TtlCache<OrgRepo[]>(5 * 60 * 1000);

export function getOctokit(): Octokit {
  // 1. Try AsyncLocalStorage context (Lambda per-request token)
  const ctx = requestContext.getStore();
  if (ctx?.token) {
    let octokit = octokitCache.get(ctx.token);
    if (!octokit) {
      octokit = new Octokit({
        auth: ctx.token,
        userAgent: "github-org-monitor-mcp/1.0.0",
      });
      octokitCache.set(ctx.token, octokit);
      // Evict old entries if cache grows too large
      if (octokitCache.size > 100) {
        const firstKey = octokitCache.keys().next().value;
        if (firstKey) octokitCache.delete(firstKey);
      }
    }
    return octokit;
  }

  // 2. Fallback to GITHUB_TOKEN env var (stdio/local HTTP mode)
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error(
      "GITHUB_TOKEN environment variable is required. " +
      "Create a Personal Access Token at https://github.com/settings/tokens " +
      "with 'repo', 'read:org' scopes."
    );
  }

  let octokit = octokitCache.get(token);
  if (!octokit) {
    octokit = new Octokit({
      auth: token,
      userAgent: "github-org-monitor-mcp/1.0.0",
    });
    octokitCache.set(token, octokit);
  }
  return octokit;
}

// --- Rate Limit ---

export interface RateLimitInfo {
  core: { remaining: number; limit: number; reset: Date };
  search: { remaining: number; limit: number; reset: Date };
}

export async function getRateLimit(): Promise<RateLimitInfo> {
  const octokit = getOctokit();
  const { data } = await octokit.rateLimit.get();
  return {
    core: {
      remaining: data.resources.core.remaining,
      limit: data.resources.core.limit,
      reset: new Date(data.resources.core.reset * 1000),
    },
    search: {
      remaining: data.resources.search.remaining,
      limit: data.resources.search.limit,
      reset: new Date(data.resources.search.reset * 1000),
    },
  };
}

/**
 * Check rate limits and throw a descriptive error if exhausted.
 * Call this before expensive multi-repo operations.
 */
export async function ensureRateLimit(
  type: "core" | "search",
  needed: number
): Promise<void> {
  const limits = await getRateLimit();
  const info = limits[type];
  if (info.remaining < needed) {
    const resetIn = Math.ceil(
      (info.reset.getTime() - Date.now()) / 1000 / 60
    );
    throw new Error(
      `GitHub ${type} API rate limit too low: ${info.remaining}/${info.limit} remaining. ` +
      `Resets in ~${resetIn} minutes. Reduce scope or wait.`
    );
  }
}

// --- Contributor Stats (with cache + retry) ---

/**
 * Fetch contributor stats with retry logic for 202 responses.
 * GitHub returns 202 when stats are being computed in the background.
 * Results are cached for 5 minutes.
 */
export async function fetchContributorStats(
  owner: string,
  repo: string,
  maxRetries = 3,
  delayMs = 2000
): Promise<ContributorStats[]> {
  const cacheKey = `${owner}/${repo}`;
  const cached = contributorStatsCache.get(cacheKey);
  if (cached) return cached;

  const octokit = getOctokit();

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const response = await octokit.request(
      "GET /repos/{owner}/{repo}/stats/contributors",
      { owner, repo }
    );

    if (response.status === 200 && Array.isArray(response.data)) {
      const stats = response.data as ContributorStats[];
      contributorStatsCache.set(cacheKey, stats);
      return stats;
    }

    // 202 means stats are being computed
    if (response.status === 202 && attempt < maxRetries - 1) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  return [];
}

// --- Org Repos (with cache) ---

/**
 * Get all repos for an org, handling pagination automatically.
 * Results are cached for 5 minutes.
 */
export async function getOrgRepos(org: string): Promise<OrgRepo[]> {
  const cached = orgReposCache.get(org);
  if (cached) return cached;

  const octokit = getOctokit();
  const repos = await octokit.paginate(octokit.repos.listForOrg, {
    org,
    per_page: 100,
    type: "all",
  });
  const result = repos.map((r) => ({
    name: r.name,
    full_name: r.full_name,
    language: r.language ?? null,
    private: r.private,
    archived: r.archived ?? false,
    updated_at: r.updated_at ?? null,
    stargazers_count: r.stargazers_count ?? 0,
  }));

  orgReposCache.set(org, result);
  return result;
}

// Types

export interface ContributorStats {
  author: {
    login: string;
    id: number;
    avatar_url: string;
  };
  total: number;
  weeks: Array<{
    w: number; // Unix timestamp for start of week
    a: number; // additions
    d: number; // deletions
    c: number; // commits
  }>;
}

export interface OrgRepo {
  name: string;
  full_name: string;
  language: string | null;
  private: boolean;
  archived: boolean;
  updated_at: string | null;
  stargazers_count: number;
}
