// @skillstate/opencode — OpenCode platform adapter + npm plugin entry.
import { createSkillStatePlugin } from './plugin.js';

export * from './opencode-adapter.js';
export * from './plugin.js';

/**
 * Ready-made npm-plugin entry for DIRECT loading from a project
 * `opencode.json` (`"plugin": ["@skillstate/opencode"]`): opencode loads
 * the npm package and calls the exported plugin function, which returns
 * the skillstate hooks (per-project state resolution and the
 * inert-without-state guards included — see `createSkillStatePlugin`).
 * The default export carries the same function for hosts that import the
 * module default.
 */
export const SkillStatePlugin = createSkillStatePlugin();

export default SkillStatePlugin;
