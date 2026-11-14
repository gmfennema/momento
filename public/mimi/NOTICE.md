# Mimi codec model provenance

The ONNX models in this directory are derived from **Mimi**, the neural audio
codec by Kyutai: <https://huggingface.co/kyutai/mimi> — licensed under
[Creative Commons Attribution 4.0](https://creativecommons.org/licenses/by/4.0/)
(CC-BY-4.0). Mimi is described in *Moshi: a speech-text foundation model for
real-time dialogue* (Défossez et al., 2024).

- `mimi-encoder-int8.onnx` — the encoder from
  [onnx-community/kyutai-mimi-ONNX](https://huggingface.co/onnx-community/kyutai-mimi-ONNX)
  (`onnx/encoder_model.onnx`).
- `mimi-decoder-int8.onnx` — a decoder exported by Momento from the
  `transformers` `MimiModel` as a fixed 10-second graph that takes all 32
  code rows plus a per-row mask, so one model decodes any code depth.

Changes made: both graphs had their large weights converted to int8 with
per-channel scales (weight-only quantization); the decoder's codebook
embeddings were precomputed. Scripts to reproduce them are in
`scripts/mimi/` in the Momento repository. No other changes were made.

The runtime that executes these models in the browser, `onnxruntime-web`
(copied to `public/ort/` at install time), is MIT-licensed by Microsoft:
<https://github.com/microsoft/onnxruntime>.
