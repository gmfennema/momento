# Rebuilding the Mimi models in `public/mimi/`

Needs Python 3.11 with `torch`, `transformers`, `onnx`, `onnxscript`, `onnxruntime`.

```bash
# decoder: fixed 10 s graph, all 32 code rows + a per-row mask (any depth 1–32)
python export_decoder.py                      # → mimi_dec_fp32.onnx
python - <<'PY'                               # drop initializers the graph never reads
import onnx; m = onnx.load('mimi_dec_fp32.onnx'); used = {i for n in m.graph.node for i in n.input}
keep = [t for t in m.graph.initializer if t.name in used]; del m.graph.initializer[:]; m.graph.initializer.extend(keep); onnx.save(m, 'mimi_dec_fp32.onnx')
PY
python int8_weights.py mimi_dec_fp32.onnx ../../public/mimi/mimi-decoder-int8.onnx

# encoder: the onnx-community fp32 export, same int8 weight pass
curl -L -o mimi_enc_fp32.onnx https://huggingface.co/onnx-community/kyutai-mimi-ONNX/resolve/main/onnx/encoder_model.onnx
python int8_weights.py mimi_enc_fp32.onnx ../../public/mimi/mimi-encoder-int8.onnx
```

The int8 pass is weight-only (per-channel scales along axis 0 — see the note
in `int8_weights.py` on why not the output axis — with `DequantizeLinear` in
front of each large weight), so the graphs compute in float32. On our test
set the int8 pair scores the same as the PyTorch reference (UTMOS 3.80 vs 3.83
at 10 codes/frame, speaker similarity 0.979 vs 0.978).
