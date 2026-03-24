import { z } from "zod/v4";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getOctokit } from "../github-client.js";
import { githubSlug } from "./schemas.js";

export function registerBranchTools(server: McpServer) {
  // list_branches
  server.registerTool(
    "list_branches",
    {
      title: "List Branches",
      description:
        "List branches for a repository with their latest commit info. Shows protection status.",
      inputSchema: z.object({
        owner: githubSlug.describe("Repository owner (organization or user)"),
        repo: z.string().describe("Repository name"),
        per_page: z
          .number()
          .min(1)
          .max(100)
          .optional()
          .describe("Results per page (default: 30, max: 100)"),
      }),
    },
    async ({ owner, repo, per_page }) => {
      const octokit = getOctokit();
      const { data } = await octokit.repos.listBranches({
        owner,
        repo,
        per_page: per_page ?? 30,
      });

      const branches = data.map((b) => ({
        name: b.name,
        sha: b.commit.sha,
        protected: b.protected,
      }));

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                repo: `${owner}/${repo}`,
                total: branches.length,
                branches,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // compare_branches
  server.registerTool(
    "compare_branches",
    {
      title: "Compare Branches",
      description:
        "Compare two branches/tags/commits. Shows ahead/behind counts, changed files, and commits between them.",
      inputSchema: z.object({
        owner: githubSlug.describe("Repository owner (organization or user)"),
        repo: z.string().describe("Repository name"),
        base: z.string().describe("Base branch/tag/SHA"),
        head: z.string().describe("Head branch/tag/SHA to compare"),
        include_patches: z
          .boolean()
          .optional()
          .describe("Include file patches/diffs (default: false, can be large)"),
      }),
    },
    async ({ owner, repo, base, head, include_patches }) => {
      const octokit = getOctokit();
      const { data } = await octokit.repos.compareCommits({
        owner,
        repo,
        base,
        head,
      });

      const commits = data.commits.map((c) => ({
        sha: c.sha.substring(0, 7),
        message: c.commit.message.split("\n")[0], // first line only
        author: c.commit.author?.name,
        date: c.commit.author?.date,
      }));

      const files = (data.files ?? []).map((f) => ({
        filename: f.filename,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
        ...(include_patches && f.patch ? { patch: f.patch } : {}),
      }));

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                repo: `${owner}/${repo}`,
                base,
                head,
                status: data.status,
                ahead_by: data.ahead_by,
                behind_by: data.behind_by,
                total_commits: data.total_commits,
                commits,
                files_changed: files.length,
                files,
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
