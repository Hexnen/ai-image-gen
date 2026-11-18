# Vendored: transformers.js + ONNX Runtime Web

Copied unchanged from the npm packages (W6-I, 2026-11-18). Do not edit; replace all files together when upgrading
(the bundled ORT JS and the WASM must be the same build), then update the hashes in dev/test-depth-post.mjs.

| File | From | sha256 |
|---|---|---|
| `transformers.min.js` | `@huggingface/transformers@4.3.2` `dist/transformers.min.js` (ESM, bundles the ORT JS) | `8b5a3171f8876bab2b1820a7d65eb87628e3d30bb5ea85b9dd398e76eb34decb` |
| `ort-wasm-simd-threaded.asyncify.mjs` | `onnxruntime-web@1.31.0-dev.20260914-8d85527a0` `dist/` (the version 4.3.2 depends on) | `0966b6105cd936744498aa60df7a22cbd47af3374dbc64a9ab561c08a71e3611` |
| `ort-wasm-simd-threaded.asyncify.wasm` | same package (WebGPU + WASM execution providers) | `49871f5a4409519797e127440868a6d1923339d9185907f301a5b2a1d90af082` |
| `LICENSE` | `@huggingface/transformers` (Apache-2.0) | |
| `LICENSE-onnxruntime.txt` | MIT licence of ONNX Runtime (the npm package ships none; text of microsoft/onnxruntime LICENSE) | |

Why local: the library's default loads the WASM from cdn.jsdelivr.net; `scripts/depth/engine.mjs` points
`env.backends.onnx.wasm.wasmPaths` at these files, so the only remote requests are the model files from huggingface.co.
