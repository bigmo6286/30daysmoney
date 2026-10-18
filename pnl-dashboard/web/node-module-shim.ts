// Browser stand-in for node:module. The Node build of the DLMM reader loads Meteora's SDK through
// createRequire (its ESM build fails under Node); a bundler can import it directly.
import DLMM from "@meteora-ag/dlmm";
export const createRequire = () => () => DLMM;
