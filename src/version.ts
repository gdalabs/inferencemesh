/**
 * The version, as a value the bundler can inline.
 *
 * Not `import pkg from '../package.json'`, which is the obvious way and breaks
 * the single executable: a JSON import inlines the *whole* file, scripts
 * included, and `build:binary` contains the SEA sentinel string. postject then
 * finds two occurrences of it in the binary and refuses to inject — a failure
 * with nothing to do with versions, in a build the unit tests never touch.
 *
 * Kept in step with package.json by a test rather than by discipline.
 */
export const VERSION = '0.1.0';
