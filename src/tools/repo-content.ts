import { z } from "zod/v4";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getOctokit } from "../github-client.js";
import { githubSlug } from "./schemas.js";

export function registerRepoContentTools(server: McpServer) {
  // get_file_content
  server.registerTool(
    "get_file_content",
    {
      title: "Get File Content",
      description:
        "Read the content of a file from a GitHub repository. Returns the decoded text content for text files, or download URL for binary files.",
      inputSchema: z.object({
        owner: githubSlug.describe("Repository owner (organization or user)"),
        repo: z.string().describe("Repository name"),
        path: z.string().describe("File path within the repository (e.g., 'src/index.ts')"),
        ref: z
          .string()
          .optional()
          .describe("Git ref (branch, tag, or SHA). Defaults to the default branch."),
      }),
    },
    async ({ owner, repo, path, ref }) => {
      const octokit = getOctokit();
      const response = await octokit.repos.getContent({
        owner,
        repo,
        path,
        ...(ref && { ref }),
      });

      const data = response.data;

      // Single file
      if (!Array.isArray(data) && data.type === "file") {
        if (data.encoding === "base64" && data.content) {
          const decoded = Buffer.from(data.content, "base64").toString("utf-8");
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    path: data.path,
                    name: data.name,
                    size: data.size,
                    sha: data.sha,
                    content: decoded,
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }
        // Binary or too large — return metadata + download URL
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  path: data.path,
                  name: data.name,
                  size: data.size,
                  sha: data.sha,
                  download_url: data.download_url,
                  note: "File is binary or too large. Use download_url to fetch.",
                },
                null,
                2
              ),
            },
          ],
        };
      }

      // If it's a directory, return listing
      if (Array.isArray(data)) {
        const entries = data.map((item) => ({
          name: item.name,
          path: item.path,
          type: item.type,
          size: item.size,
        }));
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  path,
                  type: "directory",
                  entries,
                  total: entries.length,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ path, type: (data as { type: string }).type, note: "Unsupported content type" }, null, 2),
          },
        ],
      };
    }
  );

  // list_directory
  server.registerTool(
    "list_directory",
    {
      title: "List Directory",
      description:
        "List contents of a directory in a GitHub repository. Optionally recurse to get the full tree.",
      inputSchema: z.object({
        owner: githubSlug.describe("Repository owner (organization or user)"),
        repo: z.string().describe("Repository name"),
        path: z
          .string()
          .optional()
          .describe("Directory path (e.g., 'src/components'). Defaults to root."),
        ref: z
          .string()
          .optional()
          .describe("Git ref (branch, tag, or SHA). Defaults to the default branch."),
        recursive: z
          .boolean()
          .optional()
          .describe("If true, returns full recursive tree. Default: false."),
      }),
    },
    async ({ owner, repo, path, ref, recursive }) => {
      const octokit = getOctokit();

      if (recursive) {
        // Use Git Trees API for recursive listing
        const treeSha = ref || "HEAD";
        const { data } = await octokit.git.getTree({
          owner,
          repo,
          tree_sha: treeSha,
          recursive: "1",
        });

        let entries = data.tree.map((item) => ({
          path: item.path,
          type: item.type,
          size: item.size ?? null,
        }));

        // Filter by path prefix if specified
        if (path) {
          const prefix = path.endsWith("/") ? path : `${path}/`;
          entries = entries.filter((e) => e.path?.startsWith(prefix));
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  repo: `${owner}/${repo}`,
                  ref: ref ?? "default",
                  path: path ?? "/",
                  truncated: data.truncated,
                  total: entries.length,
                  entries,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      // Non-recursive: use Contents API
      const response = await octokit.repos.getContent({
        owner,
        repo,
        path: path || "",
        ...(ref && { ref }),
      });

      if (!Array.isArray(response.data)) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { error: "Path is a file, not a directory. Use get_file_content instead." },
                null,
                2
              ),
            },
          ],
        };
      }

      const entries = response.data.map((item) => ({
        name: item.name,
        path: item.path,
        type: item.type,
        size: item.size,
      }));

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                repo: `${owner}/${repo}`,
                ref: ref ?? "default",
                path: path ?? "/",
                total: entries.length,
                entries,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // search_code
  server.registerTool(
    "search_code",
    {
      title: "Search Code",
      description:
        "Search for code across organization repositories using GitHub code search. Returns matching file paths and code snippets.",
      inputSchema: z.object({
        query: z.string().describe("Search query (e.g., 'useState hook', 'class UserService')"),
        org: githubSlug
          .optional()
          .describe("Limit search to this organization"),
        repo: z
          .string()
          .optional()
          .describe("Limit search to a specific repo (format: 'owner/repo')"),
        language: z
          .string()
          .optional()
          .describe("Filter by programming language (e.g., 'typescript', 'python')"),
        per_page: z
          .number()
          .min(1)
          .max(100)
          .optional()
          .describe("Results per page (default: 30, max: 100)"),
      }),
    },
    async ({ query, org, repo, language, per_page }) => {
      const octokit = getOctokit();

      let q = query;
      if (org) q += ` org:${org}`;
      if (repo) q += ` repo:${repo}`;
      if (language) q += ` language:${language}`;

      const { data } = await octokit.search.code({
        q,
        per_page: per_page ?? 30,
      });

      const results = data.items.map((item) => ({
        name: item.name,
        path: item.path,
        repository: item.repository.full_name,
        url: item.html_url,
        score: item.score,
        text_matches: item.text_matches?.map((tm) => ({
          fragment: tm.fragment,
        })),
      }));

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                query,
                total_count: data.total_count,
                returned: results.length,
                items: results,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // get_commit_diff
  server.registerTool(
    "get_commit_diff",
    {
      title: "Get Commit Diff",
      description:
        "Get the diff (changed files and patches) for a specific commit SHA.",
      inputSchema: z.object({
        owner: githubSlug.describe("Repository owner (organization or user)"),
        repo: z.string().describe("Repository name"),
        sha: z.string().describe("Commit SHA"),
      }),
    },
    async ({ owner, repo, sha }) => {
      const octokit = getOctokit();
      const { data } = await octokit.repos.getCommit({
        owner,
        repo,
        ref: sha,
      });

      const files = (data.files ?? []).map((f) => ({
        filename: f.filename,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
        changes: f.changes,
        patch: f.patch ?? null,
      }));

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                sha: data.sha,
                message: data.commit.message,
                author: data.commit.author?.name,
                date: data.commit.author?.date,
                stats: data.stats,
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
