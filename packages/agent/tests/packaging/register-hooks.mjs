import { register } from "node:module";

// Register the load-recorder hook on the main thread before the probe runs.
register(new URL("./hooks.mjs", import.meta.url));
