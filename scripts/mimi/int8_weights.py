# Weight-only int8: every float initializer ≥ 64K elements → int8 + per-channel
# scale + DequantizeLinear, so the graph still computes in float32 but ships at
# a quarter of the size. One scale per slice along axis 0 of every weight.
#
# Axis 0 is the output channel for Conv and the row for embedding tables, but
# the *input* channel for ConvTranspose ([in, out, k]) and MatMul B ([in, out]).
# Output-channel scales for those (AXIS=output) measured worse on Mimi's
# decoder — 26.5 dB vs 29.3 dB SNR against fp32 over our test clips, encoder
# code agreement unchanged — so the shipped models use axis 0 throughout.
# Usage: python int8_weights.py in.onnx out.onnx      (AXIS=output to compare)
import os
import sys

import numpy as np
import onnx
from onnx import helper, numpy_helper

m = onnx.load(sys.argv[1])
g = m.graph

consumer = {}
for n in g.node:
    for pos, name in enumerate(n.input):
        consumer.setdefault(name, (n.op_type, pos))


def channel_axis(name: str, ndim: int) -> int:
    if os.environ.get('AXIS') != 'output':
        return 0
    op, pos = consumer.get(name, ('', 0))
    if op == 'ConvTranspose':
        return 1
    if op == 'MatMul' and pos == 1:
        return ndim - 1
    return 0


new_inits, new_nodes = [], []
for t in list(g.initializer):
    a = numpy_helper.to_array(t)
    if a.dtype != np.float32 or a.size < 65536:
        new_inits.append(t)
        continue
    axis = channel_axis(t.name, a.ndim)
    reduce = tuple(i for i in range(a.ndim) if i != axis)
    scale = (np.abs(a).max(axis=reduce) / 127.0).astype(np.float32)
    scale[scale == 0] = 1e-8
    shape = [1] * a.ndim
    shape[axis] = -1
    q = np.clip(np.round(a / scale.reshape(shape)), -127, 127).astype(np.int8)
    new_inits += [numpy_helper.from_array(q, t.name + '_q'), numpy_helper.from_array(scale, t.name + '_s')]
    new_nodes.append(helper.make_node('DequantizeLinear', [t.name + '_q', t.name + '_s'], [t.name], axis=axis))

del g.initializer[:]
g.initializer.extend(new_inits)
nodes = list(g.node)
del g.node[:]
g.node.extend(new_nodes + nodes)
onnx.save(m, sys.argv[2])
print('saved', sys.argv[2])
