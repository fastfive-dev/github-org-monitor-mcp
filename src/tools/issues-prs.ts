import { z } from "zod/v4";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getOctokit } from "../github-client.js";
import { githubSlug, isoDate } from "./schemas.js";

export function registerIssuePRDetailTools(server: McpServer) {
  // get_pr_detail
  server.registerTool(
    "get_pr_detail",
    {
      title: "Get Pull Request Detail",
      description:
        "Get full details of a pull request including description, changed files, review comments, and review status.",
      inputSchema: z.object({
        owner: githubSlug.describe("Repository owner (organization or user)"),
        repo: z.string().describe("Repository name"),
        pull_number: z.number().int().positive().describe("Pull request number"),
        include_diff: z
          .boolean()
          .optional()
          .describe("Include file diffs/patches (default: false, can be large)"),
      }),
    },
    async ({ owner, repo, pull_number, include_diff }) => {
      const octokit = getOctokit();

      // Fetch PR, files, and reviews in parallel
      const [prResponse, filesResponse, reviewsResponse] = await Promise.all([
        octokit.pulls.get({ owner, repo, pull_number }),
        octokit.paginate(octokit.pulls.listFiles, {
          owner,
          repo,
          pull_number,
          per_page: 100,
        }),
        octokit.paginate(octokit.pulls.listReviews, {
          owner,
          repo,
          pull_number,
          per_page: 100,
        }),
      ]);

      const pr = prResponse.data;

      const files = filesResponse.map((f) => ({
        filename: f.filename,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
        ...(include_diff && f.patch ? { patch: f.patch } : {}),
      }));

      const reviews = reviewsResponse.map((r) => ({
        user: r.user?.login,
        state: r.state,
        body: r.body || null,
        submitted_at: r.submitted_at,
      }));

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                number: pr.number,
                title: pr.title,
                state: pr.state,
                merged: pr.merged,
                draft: pr.draft,
                author: pr.user?.login,
                created_at: pr.created_at,
                updated_at: pr.updated_at,
                merged_at: pr.merged_at,
                closed_at: pr.closed_at,
                base: pr.base.ref,
                head: pr.head.ref,
                body: pr.body,
                additions: pr.additions,
                deletions: pr.deletions,
                changed_files: pr.changed_files,
                labels: pr.labels.map((l) => l.name),
                reviewers: pr.requested_reviewers?.map((r) =>
                  "login" in r ? r.login : (r as { name: string }).name
                ),
                files,
                reviews,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // list_repo_issues
  server.registerTool(
    "list_repo_issues",
    {
      title: "List Repository Issues",
      description:
        "List issues for a repository with filtering by state, labels, assignee, and date range.",
      inputSchema: z.object({
        owner: githubSlug.describe("Repository owner (organization or user)"),
        repo: z.string().describe("Repository name"),
        state: z
          .enum(["open", "closed", "all"])
          .optional()
          .describe("Issue state filter (default: 'open')"),
        labels: z
          .string()
          .optional()
          .describe("Comma-separated list of label names"),
        assignee: z
          .string()
          .optional()
          .describe("Filter by assignee username, or 'none' / '*'"),
        since: isoDate
          .optional()
          .describe("Only issues updated after this date (ISO 8601)"),
        per_page: z
          .number()
          .min(1)
          .max(100)
          .optional()
          .describe("Results per page (default: 30, max: 100)"),
        sort: z
          .enum(["created", "updated", "comments"])
          .optional()
          .describe("Sort field (default: 'created')"),
      }),
    },
    async ({ owner, repo, state, labels, assignee, since, per_page, sort }) => {
      const octokit = getOctokit();
      const { data } = await octokit.issues.listForRepo({
        owner,
        repo,
        state: state ?? "open",
        ...(labels && { labels }),
        ...(assignee && { assignee }),
        ...(since && { since }),
        per_page: per_page ?? 30,
        sort: sort ?? "created",
        direction: "desc",
      });

      // Filter out PRs (GitHub issues API includes PRs)
      const issues = data
        .filter((item) => !item.pull_request)
        .map((item) => ({
          number: item.number,
          title: item.title,
          state: item.state,
          author: item.user?.login,
          assignees: item.assignees?.map((a) => a.login),
          labels: item.labels.map((l) =>
            typeof l === "string" ? l : l.name
          ),
          comments: item.comments,
          created_at: item.created_at,
          updated_at: item.updated_at,
          closed_at: item.closed_at,
        }));

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                repo: `${owner}/${repo}`,
                state: state ?? "open",
                total: issues.length,
                issues,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // get_issue_detail
  server.registerTool(
    "get_issue_detail",
    {
      title: "Get Issue Detail",
      description:
        "Get full details of an issue including body, comments, labels, and timeline.",
      inputSchema: z.object({
        owner: githubSlug.describe("Repository owner (organization or user)"),
        repo: z.string().describe("Repository name"),
        issue_number: z.number().int().positive().describe("Issue number"),
      }),
    },
    async ({ owner, repo, issue_number }) => {
      const octokit = getOctokit();

      const [issueResponse, commentsResponse] = await Promise.all([
        octokit.issues.get({ owner, repo, issue_number }),
        octokit.paginate(octokit.issues.listComments, {
          owner,
          repo,
          issue_number,
          per_page: 100,
        }),
      ]);

      const issue = issueResponse.data;

      const comments = commentsResponse.map((c) => ({
        user: c.user?.login,
        body: c.body,
        created_at: c.created_at,
        updated_at: c.updated_at,
        reactions: c.reactions
          ? {
              "+1": c.reactions["+1"],
              "-1": c.reactions["-1"],
              heart: c.reactions.heart,
            }
          : null,
      }));

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                number: issue.number,
                title: issue.title,
                state: issue.state,
                state_reason: issue.state_reason,
                author: issue.user?.login,
                assignees: issue.assignees?.map((a) => a.login),
                labels: issue.labels.map((l) =>
                  typeof l === "string" ? l : l.name
                ),
                milestone: issue.milestone?.title ?? null,
                created_at: issue.created_at,
                updated_at: issue.updated_at,
                closed_at: issue.closed_at,
                body: issue.body,
                comments_count: issue.comments,
                comments,
                reactions: issue.reactions
                  ? {
                      "+1": issue.reactions["+1"],
                      "-1": issue.reactions["-1"],
                      heart: issue.reactions.heart,
                      total: issue.reactions.total_count,
                    }
                  : null,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // list_repo_prs
  server.registerTool(
    "list_repo_prs",
    {
      title: "List Repository Pull Requests",
      description:
        "List pull requests for a repository with filtering by state, base branch, and sorting.",
      inputSchema: z.object({
        owner: githubSlug.describe("Repository owner (organization or user)"),
        repo: z.string().describe("Repository name"),
        state: z
          .enum(["open", "closed", "all"])
          .optional()
          .describe("PR state filter (default: 'open')"),
        base: z
          .string()
          .optional()
          .describe("Filter by base branch (e.g., 'main')"),
        sort: z
          .enum(["created", "updated", "popularity", "long-running"])
          .optional()
          .describe("Sort field (default: 'created')"),
        per_page: z
          .number()
          .min(1)
          .max(100)
          .optional()
          .describe("Results per page (default: 30, max: 100)"),
      }),
    },
    async ({ owner, repo, state, base, sort, per_page }) => {
      const octokit = getOctokit();
      const { data } = await octokit.pulls.list({
        owner,
        repo,
        state: state ?? "open",
        ...(base && { base }),
        sort: sort ?? "created",
        direction: "desc",
        per_page: per_page ?? 30,
      });

      const prs = data.map((pr) => ({
        number: pr.number,
        title: pr.title,
        state: pr.state,
        draft: pr.draft,
        author: pr.user?.login,
        base: pr.base.ref,
        head: pr.head.ref,
        created_at: pr.created_at,
        updated_at: pr.updated_at,
        merged_at: pr.merged_at,
        labels: pr.labels.map((l) => l.name),
        reviewers: pr.requested_reviewers?.map((r) =>
          "login" in r ? r.login : (r as { name: string }).name
        ),
      }));

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                repo: `${owner}/${repo}`,
                state: state ?? "open",
                total: prs.length,
                pull_requests: prs,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );
}
