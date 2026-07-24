# Neural bandwidth-extension model provenance

The ONNX models in this directory are float16 conversions of the **LavaSR**
speech-restoration model:

- `enhancer-backbone-fp16.onnx` — Vocos-style ConvNeXt backbone
- `enhancer-spec-head-fp16.onnx` — ISTFT spectrogram head

Upstream projects:

- [ysharma3501/LavaSR](https://github.com/ysharma3501/LavaSR) — the original
  model and weights (Apache-2.0).
- [Topping1/LavaSR-ONNX](https://github.com/Topping1/LavaSR-ONNX) — the
  PyTorch-free ONNX export these files were converted from (Apache-2.0),
  release `Alpha-v0.1` assets `enhancer_backbone.onnx` /
  `enhancer_spec_head.onnx`.

The float32 → float16 weight conversion was done with
[onnxconverter-common](https://github.com/microsoft/onnxconverter-common)
(`convert_float_to_float16(model, keep_io_types=True)`); graph structure and
IO signatures are otherwise unchanged.

Both upstream projects are licensed under the Apache License 2.0. A copy of
the license is available at <https://www.apache.org/licenses/LICENSE-2.0>.

The runtime that executes these models in the browser, `onnxruntime-web`
(copied to `public/ort/` at install time), is MIT-licensed by Microsoft:
<https://github.com/microsoft/onnxruntime>.
