# The mapping schema has no value field

The tool promises it never invents an answer, and a model able to return one
will eventually do it. The mapping response schema therefore carries no value
field at all: the model can say which stored key answers a Field and nothing
more, so every Value written on Fill comes from the store. The cost is a less
flexible mapping step, which cannot offer an answer even when it would be right.
