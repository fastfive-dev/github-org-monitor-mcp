import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  DeleteCommand,
} from "@aws-sdk/lib-dynamodb";

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);

function getTableName(): string {
  return process.env.TOKEN_TABLE || "mcp-github-tokens";
}

// --- User tokens (pk: "user#{github_user_id}") ---

export interface UserToken {
  githubUserId: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // Unix timestamp
}

export async function saveUserToken(token: UserToken): Promise<void> {
  const ttl = Math.floor(Date.now() / 1000) + 90 * 24 * 60 * 60; // 90 days
  await docClient.send(
    new PutCommand({
      TableName: getTableName(),
      Item: {
        pk: `user#${token.githubUserId}`,
        accessToken: token.accessToken,
        refreshToken: token.refreshToken,
        expiresAt: token.expiresAt,
        ttl,
      },
    })
  );
}

export async function getUserToken(
  githubUserId: string
): Promise<UserToken | null> {
  const result = await docClient.send(
    new GetCommand({
      TableName: getTableName(),
      Key: { pk: `user#${githubUserId}` },
    })
  );
  if (!result.Item) return null;
  return {
    githubUserId,
    accessToken: result.Item.accessToken as string,
    refreshToken: result.Item.refreshToken as string,
    expiresAt: result.Item.expiresAt as number,
  };
}

// --- Auth codes (pk: "auth#{code}") ---

export interface AuthCode {
  code: string;
  codeChallenge: string;
  githubUserId: string;
  redirectUri: string;
}

export async function saveAuthCode(authCode: AuthCode): Promise<void> {
  const ttl = Math.floor(Date.now() / 1000) + 10 * 60; // 10 minutes
  await docClient.send(
    new PutCommand({
      TableName: getTableName(),
      Item: {
        pk: `auth#${authCode.code}`,
        codeChallenge: authCode.codeChallenge,
        githubUserId: authCode.githubUserId,
        redirectUri: authCode.redirectUri,
        ttl,
      },
    })
  );
}

export async function getAndDeleteAuthCode(
  code: string
): Promise<AuthCode | null> {
  const key = { pk: `auth#${code}` };
  const result = await docClient.send(
    new GetCommand({ TableName: getTableName(), Key: key })
  );
  if (!result.Item) return null;

  // Delete immediately (one-time use)
  await docClient.send(
    new DeleteCommand({ TableName: getTableName(), Key: key })
  );

  return {
    code,
    codeChallenge: result.Item.codeChallenge as string,
    githubUserId: result.Item.githubUserId as string,
    redirectUri: result.Item.redirectUri as string,
  };
}
