
import * as base from './base.js';

const ggml = {};
const gguf = {};

ggml.ModelFactory = class {

    match(context) {
        return gguf.Reader.open(context.stream);
    }

    async open(context, target) {
        target.read();
        return new ggml.Model(target);
    }
};

ggml.Model = class {

    constructor(target) {
        this.format = target.format;
        const layers = new Map();
        layers.map = (key) => {
            if (!layers.has(key)) {
                layers.set(key, { metadata: new Map(), weights: new Map() });
            }
            return layers.get(key);
        };
        this.metadata = new Map();
        const metadata = new Map();
        for (const [name, value] of target.metadata) {
            switch (name) {
                case 'general.name': this.name = value; break;
                case 'general.architecture': this.runtime = value; break;
                case 'general.description': this.description = value; break;
                case 'general.author': this.metadata.set('author', value); break;
                case 'general.license': this.metadata.set('license', value); break;
                case 'general.file_type':
                case 'general.quantization_version':
                    break;
                default:
                    metadata.set(name, value);
                    break;
            }
        }
        for (const [name, value] of metadata) {
            if (name.startsWith('tokenizer.')) {
                const [key, param] = name.match(/^(.*)\.(.*?)$/).slice(1);
                const layer = layers.map(key);
                layer.type = 'Tokenizer';
                layer.metadata.set(param, value);
            } else if (this.runtime && name.startsWith(this.runtime + '.')) {
                const layer = layers.map('');
                layer.type = 'Parameters';
                layer.metadata.set(name, value);
            } else {
                this.metadata.set(name, value);
            }
        }
        for (const [name, tensor] of target.tensors) {
            const [key, param] = name.match(/^(.*)\.(.*?)$/).slice(1);
            const layer = layers.map(key);
            layer.type = 'Weights';
            layer.weights.set(param, tensor);
        }
        this.graphs = [ new ggml.Graph(target.metadata, layers) ];
    }
};

ggml.Graph = class {

    constructor(metadata, layers) {
        this.nodes = [];
        this.inputs = [];
        this.outputs = [];
        for (const [name, layer] of layers) {
            const node = new ggml.Node(name, layer);
            this.nodes.push(node);
        }
    }
};

ggml.Argument = class {

    constructor(name, value) {
        this.name = name;
        this.value = value;
    }
};

ggml.Value = class {

    constructor(name, tensor) {
        this.name = name;
        this.type = tensor.type;
        this.quantization = tensor.quantization;
        this.initializer = tensor;
    }
};

ggml.Node = class {

    constructor(name, layer) {
        this.type = { name: layer.type };
        this.name = name;
        this.inputs = [];
        this.outputs = [];
        this.attributes = [];
        for (const [name, weight] of layer.weights) {
            const tensor = new ggml.Tensor(weight);
            const value = new ggml.Value(weight.name, tensor);
            const argument = new ggml.Argument(name, [ value ]);
            this.inputs.push(argument);
        }
        for (const [name, value] of layer.metadata) {
            const attribute = new ggml.Attribute(name, value);
            this.attributes.push(attribute);
        }
    }
};

ggml.Attribute = class {

    constructor(name, value) {
        this.name = name;
        this.value = value;
    }
};

ggml.TensorType = class {

    constructor(dataType, shape) {
        this.dataType = dataType;
        this.shape = shape;
    }

    toString() {
        return (this.dataType || '?') + this.shape.toString();
    }
};

ggml.TensorShape = class {

    constructor(dimensions) {
        this.dimensions = dimensions;
    }

    toString() {
        return '[' + this.dimensions.map((dimension) => dimension.toString()).join(',') + ']';
    }
};

ggml.Tensor = class {

    constructor(tensor) {
        const shape = new ggml.TensorShape(tensor.ne);
        this.type = new ggml.TensorType(tensor.dtype, shape);
        if (tensor.type !== ggml.QuantizationType.F32 && tensor.type !== ggml.QuantizationType.F16) {
            this.quantization = ggml.Utility.enum(ggml.QuantizationType, tensor.type);
        }
        if (tensor.dtype === 'float32' || tensor.dtype === 'float16') {
            this.encoding = '<';
            this._data = tensor.data;
        }
    }

    get values() {
        if (this._data) {
            return this._data.peek();
        }
        return null;
    }
};


gguf.Reader = class {

    static open(stream) {
        if (stream && stream.length > 4) {
            const signature = String.fromCharCode.apply(null, stream.peek(4));
            if (signature === 'GGUF') {
                return new gguf.Reader(stream);
            }
        }
        return null;
    }

    constructor(stream) {
        this._stream = stream;
        const QK_K = 256;
        gguf.Reader.GGML_QUANT_SIZES = gguf.Reader.GGML_QUANT_SIZES || new Map([
            [ ggml.QuantizationType.F32,  [ 1, 4, 'float32' ] ],
            [ ggml.QuantizationType.F16,  [ 1, 2, 'float16' ] ],
            [ ggml.QuantizationType.Q4_0, [ 32, 2 + 16, '' ] ],
            [ ggml.QuantizationType.Q4_1, [ 32, 2 + 2 + 16, '' ] ],
            [ ggml.QuantizationType.Q5_0, [ 32, 2 + 4 + 16, '' ] ],
            [ ggml.QuantizationType.Q5_1, [ 32, 2 + 2 + 4 + 16, '' ] ],
            [ ggml.QuantizationType.Q8_0, [ 32, 2 + 32, ''] ],
            [ ggml.QuantizationType.Q8_1, [ 32, 4 + 4 + 32, ''] ],
            [ ggml.QuantizationType.Q2_K, [ 256, 2 + 2 + Math.floor(QK_K / 16) + Math.floor(QK_K / 4), '' ] ],
            [ ggml.QuantizationType.Q3_K, [ 256, 2 + Math.floor(QK_K / 4) + Math.floor(QK_K / 8) + 12, '' ] ],
            [ ggml.QuantizationType.Q4_K, [ 256, 2 + 2 + Math.floor(QK_K / 2) + 12, '' ] ],
            [ ggml.QuantizationType.Q5_K, [ 256, 2 + 2 + Math.floor(QK_K / 2) + Math.floor(QK_K / 8) + 12, '' ] ],
            [ ggml.QuantizationType.Q6_K, [ 256, 2 + Math.floor(QK_K / 2) + Math.floor(QK_K / 4) + Math.floor(QK_K / 16), '' ] ],
            [ ggml.QuantizationType.Q8_K, [ 256, 4 + QK_K + Math.floor(QK_K / 8), '' ] ],
            [ ggml.QuantizationType.I8,   [ 1, 4, 'int8' ] ],
            [ ggml.QuantizationType.I16,  [ 1, 2, 'int16' ] ],
            [ ggml.QuantizationType.I32,  [ 1, 4, 'int32' ] ]
        ]);
    }

    read() {
        const reader = new gguf.StreamReader(this._stream);
        this.tensors = new Map();
        this.metadata = new Map();
        const context = {};
        context.header = {};
        context.header.magic = String.fromCharCode.apply(null, reader.read(4));
        context.header.version = reader.uint32();
        this.format = 'GGUF v' + context.header.version.toString();
        if (context.header.version >= 2) {
            context.header.n_tensors = reader.uint64();
            context.header.n_kv = reader.uint64();
            for (let i = 0; i < context.header.n_kv; i++) {
                const entry = reader.entry();
                this.metadata.set(entry.name, entry.value);
            }
            for (let i = 0; i < context.header.n_tensors; i++) {
                const tensor = reader.tensor();
                this.tensors.set(tensor.name, tensor);
            }
            context.alignment = this.metadata.get('general.alignment') || 32;
            const offset_pad = reader.position % context.alignment;
            if (offset_pad != 0) {
                reader.skip(context.alignment - offset_pad);
            }
            context.offset = reader.position;
            if (context.offset < this._stream.length) {
                for (const tensor of this.tensors.values()) {
                    reader.seek(context.offset + tensor.offset);
                    if (!gguf.Reader.GGML_QUANT_SIZES.has(tensor.type)) {
                        throw new ggml.Error("Unsupported tensor quantization type '" + tensor.type.toString() + "'.");
                    }
                    const [block_size, type_size, dtype] = gguf.Reader.GGML_QUANT_SIZES.get(tensor.type);
                    const n_elems = tensor.ne.reduce((a, b) => a * b, 1);
                    const n_bytes = Math.floor(n_elems * type_size / block_size);
                    tensor.dtype = dtype || '?';
                    tensor.data = reader.stream(n_bytes);
                }
            }
        }
        this._stream.seek(0);
        delete this._stream;
    }
};

gguf.StreamReader = class extends base.StreamReader {

    constructor(stream) {
        super(stream);
    }

    string() {
        const size = this.uint64();
        const buffer = this.read(size);
        return String.fromCharCode.apply(null, buffer);
    }

    value(type) {
        switch (type) {
            case gguf.Type.UINT32: {
                return this.uint32();
            }
            case gguf.Type.INT32: {
                return this.int32();
            }
            case gguf.Type.FLOAT32: {
                return this.float32();
            }
            case gguf.Type.BOOL: {
                return this.byte() !== 0;
            }
            case gguf.Type.STRING: {
                return this.string();
            }
            case gguf.Type.ARRAY: {
                const type = this.uint32();
                const size = this.uint64();
                const value = new Array(size);
                for (let i = 0; i < size; i++) {
                    value[i] = this.value(type);
                }
                return value;
            }
            default: {
                throw new ggml.Error("Unsupported GGUF type '" + type + "'.");
            }
        }
    }

    entry() {
        const name = this.string();
        const type = this.uint32();
        const value = this.value(type);
        return { name: name, value: value, type: type };
    }

    tensor() {
        const tensor = {};
        tensor.name = this.string();
        const n_dims = this.uint32();
        tensor.ne = new Array(n_dims);
        for (let i = 0; i < n_dims; i++) {
            tensor.ne[i] = this.uint64();
        }
        tensor.type = this.uint32();
        tensor.offset = this.uint64();
        return tensor;
    }
};

gguf.Type = {
    UINT8: 0,
    INT8: 1,
    UINT16: 2,
    INT16: 3,
    UINT32: 4,
    INT32: 5,
    FLOAT32: 6,
    BOOL: 7,
    STRING: 8,
    ARRAY: 9,
    UINT64: 10,
    INT64: 11,
    FLOAT64: 12,
};

ggml.QuantizationType = {
    F32: 0,
    F16: 1,
    Q4_0: 2,
    Q4_1: 3,
    Q5_0: 6,
    Q5_1: 7,
    Q8_0: 8,
    Q8_1: 9,
    Q2_K: 10,
    Q3_K: 11,
    Q4_K: 12,
    Q5_K: 13,
    Q6_K: 14,
    Q8_K: 15,
    I8: 16,
    I16: 17,
    I32: 18,
};

ggml.Utility = class {

    static enum(type, value) {
        ggml.Utility._enums = ggml.Utility._enums || new Map();
        if (!ggml.Utility._enums.has(type)) {
            const entries = new Map(Object.entries(type).map(([key, value]) => [ value, key ]));
            ggml.Utility._enums.set(type, entries);
        }
        const entires = ggml.Utility._enums.get(type);
        if (entires.has(value)) {
            return entires.get(value);
        }
        return value;
    }
};

ggml.Error = class extends Error {

    constructor(message) {
        super(message);
        this.name = 'GGML Error';
    }
};

export const ModelFactory = ggml.ModelFactory;
