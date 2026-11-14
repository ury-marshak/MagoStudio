import { parseAllowedCloudStorageUrl } from "./parseAllowedCloudStorageUrl";

const MAX_REDIRECTS = 3;
const HTTP_REDIRECT_MIN = 300;
const HTTP_REDIRECT_MAX_EXCLUSIVE = 400;

export type FetchCloudStorage = (
  url: URL,
  init: RequestInit
) => Promise<Response>;

const isRedirectStatus = (status: number): boolean =>
  status >= HTTP_REDIRECT_MIN && status < HTTP_REDIRECT_MAX_EXCLUSIVE;

export const fetchCloudStorageObject = async ({
  url,
  allowedHosts,
  method = "GET",
  range,
  signal,
  assertAccess,
  fetchFromCloudStorage = fetch
}: {
  url: unknown;
  allowedHosts: readonly string[];
  method?: "GET" | "HEAD";
  range?: string;
  signal?: AbortSignal;
  /** Main-process account policy, rechecked before every dispatch/redirect. */
  assertAccess?: () => Promise<void>;
  fetchFromCloudStorage?: FetchCloudStorage;
}): Promise<Response> => {
  let target = parseAllowedCloudStorageUrl(url, allowedHosts);
  for (let redirectsFollowed = 0; ; redirectsFollowed += 1) {
    signal?.throwIfAborted();
    await assertAccess?.();
    signal?.throwIfAborted();
    const response = await fetchFromCloudStorage(target, {
      method,
      headers: range ? { range } : {},
      redirect: "manual",
      credentials: "omit",
      signal
    });
    const redirectLocation = response.headers.get("location");
    if (!isRedirectStatus(response.status) || !redirectLocation) {
      return response;
    }
    await response.body?.cancel();
    if (redirectsFollowed >= MAX_REDIRECTS) {
      throw new Error("Too many redirects reading from Mago cloud storage");
    }
    target = parseAllowedCloudStorageUrl(
      new URL(redirectLocation, target).toString(),
      allowedHosts
    );
  }
};
