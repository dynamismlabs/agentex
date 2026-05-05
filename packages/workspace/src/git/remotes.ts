import { RemoteAlreadyExistsError } from "../errors.js";
import { remoteAdd, remoteExists, remoteSetUrl } from "./commands.js";

const ORIGIN = "origin";

export async function addRemote(cwd: string, name: string, url: string): Promise<void> {
  if (typeof name !== "string" || name.length === 0) {
    throw new Error("addRemote: name must be a non-empty string");
  }
  if (typeof url !== "string" || url.length === 0) {
    throw new Error("addRemote: url must be a non-empty string");
  }
  if (await remoteExists(cwd, name)) {
    throw new RemoteAlreadyExistsError(name);
  }
  await remoteAdd(cwd, name, url);
}

/**
 * Idempotent upsert: set `origin` to `url`, creating it if missing or updating
 * its URL if it already exists.
 */
export async function setOrigin(cwd: string, url: string): Promise<void> {
  if (typeof url !== "string" || url.length === 0) {
    throw new Error("setOrigin: url must be a non-empty string");
  }
  if (await remoteExists(cwd, ORIGIN)) {
    await remoteSetUrl(cwd, ORIGIN, url);
  } else {
    await remoteAdd(cwd, ORIGIN, url);
  }
}
