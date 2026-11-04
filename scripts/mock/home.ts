import { isolateHome } from '../isolate.ts';

// Modules evaluate in the order they are imported, so every module imported after this one, the server's own among
// them, sees the fresh HOME: none can bind the live state.db or ~/.claude. The mock's fixtures live under it.
export const HOME = isolateHome();
