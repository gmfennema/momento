# Variable-depth Mimi decoder: codes [1,32,125] int64 + mask [32] → audio [1,1,240000] @24 kHz.
import torch, types
from transformers import MimiModel
m = MimiModel.from_pretrained('kyutai/mimi').eval()
for mod in m.modules():
    if type(mod).__name__ == 'MimiEuclideanCodebook':
        mod.register_buffer('fixed_embed', mod.embed.detach().clone())
        mod.decode = types.MethodType(lambda self, ind: torch.nn.functional.embedding(ind, self.fixed_embed), mod)
ac = m.quantizer.acoustic_residual_vector_quantizer
def dec(self, codes):
    out = 0.0
    for i, idx in enumerate(codes.transpose(0, 1)):
        out = out + self.layers[i].decode(idx) * self._mask[i + 1]
    return self.output_proj(out)
ac.decode = types.MethodType(dec, ac)
class Dec(torch.nn.Module):
    def __init__(s, m): super().__init__(); s.m = m
    def forward(s, codes, mask):
        s.m.quantizer.acoustic_residual_vector_quantizer._mask = mask
        return s.m.decode(codes, return_dict=False)[0]
torch.onnx.export(Dec(m), (torch.zeros(1,32,125, dtype=torch.long), torch.ones(32)), 'mimi_dec_fp32.onnx',
                  input_names=['codes','mask'], output_names=['audio'], dynamo=True, external_data=False)
