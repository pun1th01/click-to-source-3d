import { installInstanceProbe } from "./instanceCapture.js";

/**
 * Side-effect entry: importing this installs the instance capture probe.
 *
 * Exists as its own entry because installation has to happen before the first
 * scene commits. Instance writes are once-only with no replay, so a probe that
 * arrives after the first mount captures nothing — and does so silently. The
 * Vite plugin injects an import of this module at the top of the application
 * entry; importing it by hand as the first statement of your entry works
 * equally well.
 */
installInstanceProbe();
