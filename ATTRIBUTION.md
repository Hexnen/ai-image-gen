# Third-party code and models

## Vendored code (in this module)

| What | Version | Licence | Where |
|---|---|---|---|
| `@huggingface/transformers` (transformers.js) | 4.3.2 | Apache-2.0 (`vendor/transformers/LICENSE`) | `vendor/transformers/transformers.min.js` |
| `onnxruntime-web` (ONNX Runtime Web, WASM + bundled JS) | 1.31.0-dev.20260914-8d85527a0 | MIT, Microsoft Corporation (`vendor/transformers/LICENSE-onnxruntime.txt`) | `vendor/transformers/ort-wasm-simd-threaded.asyncify.*` |

Details and hashes: `vendor/transformers/VENDOR.md`.

## Models downloaded at run time ("Dodaj głębię", browser engine)

Not shipped with the module. The GM's browser downloads them from huggingface.co on first use, after a confirmation,
and keeps them in its cache (Cache Storage `transformers-cache`).

| Model | Repository | Licence | Note |
|---|---|---|---|
| Depth Anything V2 Large | `onnx-community/depth-anything-v2-large` | CC BY-NC 4.0 | non-commercial; fine for this private module |
| Depth Anything V2 Small | `onnx-community/depth-anything-v2-small` | Apache-2.0 | fallback without WebGPU |
| BiRefNet lite (figure mask) | `onnx-community/BiRefNet_lite-ONNX` (`onnx-community/BiRefNet_lite` redirects there) | MIT | optional |

Licence sources: the model cards (cardData.license on the Hugging Face API, checked 2026-11-18) and
`dev/depth-model-research.md`.
