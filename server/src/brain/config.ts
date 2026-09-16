// Non-secret settings shared with the browser and portable Node scripts.
// TypeScript emits the JSON beside this module in server/dist/brain.
import settings = require('./config.json');

export const brainConfig = settings;
