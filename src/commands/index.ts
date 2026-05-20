export {
  registerCommand,
  getCommand,
  getAllCommands,
  clearCommands,
  parseCommand,
} from "./types.js";
export type { Command, CommandResult } from "./types.js";

// Import all commands to trigger registration
import "./help.js";
import "./clear.js";
import "./model.js";
import "./cost.js";
import "./config.js";
import "./compact.js";
