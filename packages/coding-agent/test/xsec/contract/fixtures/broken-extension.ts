/**
 * A stand-in extension that fails while it loads, on purpose. The contract test pins the signal omp gives
 * for it. It is a fixture written for this suite, not one of Desktop's extensions.
 */
throw new Error("contract fixture: this extension fails to load");
