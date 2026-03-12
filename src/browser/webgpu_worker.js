// WebGPU render worker: receives OffscreenCanvas and render payloads from ScreenAdapter

let canvas = null;
let canvas_context = null;
let device = null;
let queue = null;
let compute_pipeline = null;
let bind_group_layout = null;
let frame_texture = null;
let frame_texture_size = { width: 0, height: 0 };
let pixel_buffer_gpu = null;
let palette_buffer_gpu = null;
let dac_map_buffer_gpu = null;
let plane_buffer_gpu = null;
let params_buffer_gpu = null;

const WORKGROUP_SIZE = 8;
const MODE_VGA_PLANAR = 0;
const MODE_VGA_4BPP = 1;
const MODE_VGA_8BPP = 2;
const MODE_SVGA_8BPP = 3;
const MODE_SVGA_15BPP = 4;
const MODE_SVGA_16BPP = 5;
const MODE_SVGA_24BPP = 6;
const MODE_SVGA_32BPP = 7;

const params_array = new Uint32Array(11);

function ensure_buffer(current, size, usage, label)
{
    if(!current || current.size < size)
    {
        return device.createBuffer({ size: Math.max(size, 1024), usage, label });
    }
    return current;
}

function ensure_frame_texture(width, height, format)
{
    if(frame_texture && frame_texture_size.width === width && frame_texture_size.height === height)
    {
        return;
    }
    frame_texture_size = { width, height };
    frame_texture = device.createTexture({
        size: { width, height },
        format,
        usage: GPUTextureUsage.COPY_SRC | GPUTextureUsage.STORAGE_BINDING,
    });
}

async function initRenderer({ canvas: offscreen, adapterOptions, width, height })
{
    canvas = offscreen;
    if(typeof width === "number" && typeof height === "number")
    {
        canvas.width = width;
        canvas.height = height;
    }
    canvas_context = canvas.getContext("webgpu");
    const adapter = await navigator.gpu.requestAdapter(adapterOptions || { powerPreference: "high-performance" });
    if(!adapter)
    {
        throw new Error("WebGPU adapter unavailable in worker");
    }

    device = await adapter.requestDevice();
    queue = device.queue;

    const canvas_format = "rgba8unorm";
    canvas_context.configure({
        device,
        format: canvas_format,
        alphaMode: "opaque",
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_DST,
    });

    const shader_module = device.createShaderModule({
        label: "v86-vga-webgpu-worker",
        code: `struct Params {
    width: u32,
    height: u32,
    mask: u32,
    colorset: u32,
    mode: u32,
    color_plane_enable: u32,
    addr_shift: u32,
    addr_substitution: u32,
    shift_mode: u32,
    pel_width: u32,
    start_address: u32,
};

@group(0) @binding(0) var<storage, read> pixel_indices: array<u32>;
@group(0) @binding(1) var<storage, read> palette: array<u32>;
@group(0) @binding(2) var<storage, read> dac_map: array<u32>;
@group(0) @binding(3) var<storage, read> vga_planes: array<u32>;
@group(0) @binding(4) var out_image: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(5) var<uniform> params: Params;

fn decode_palette(color: u32) -> vec4<f32> {
    let r = f32((color >> 16u) & 0xFFu) / 255.0;
    let g = f32((color >> 8u) & 0xFFu) / 255.0;
    let b = f32(color & 0xFFu) / 255.0;
    return vec4<f32>(r, g, b, 1.0);
}

fn load_plane_byte(addr: u32) -> u32 {
    let word: u32 = vga_planes[addr >> 2u];
    let shift: u32 = (addr & 3u) * 8u;
    return (word >> shift) & 0xFFu;
}

fn vga_planar_color(idx: u32, virtual_width: u32) -> u32 {
    let pixel_addr: u32 = idx;
    var addr: u32 = (pixel_addr >> params.addr_shift) + params.start_address;

    if(params.addr_substitution != 0u) {
        var row: u32 = pixel_addr / virtual_width;
        var col: u32 = pixel_addr - virtual_width * row;

        switch params.addr_substitution {
            case 1u: {
                addr = (row & 1u) << 13u;
                row = row >> 1u;
            }
            case 2u: {
                addr = (row & 1u) << 14u;
                row = row >> 1u;
            }
            case 3u: {
                addr = (row & 3u) << 13u;
                row = row >> 2u;
            }
            default: {}
        }

        addr = addr | (((row * virtual_width + col) >> params.addr_shift));
    }

    let b0: u32 = load_plane_byte(addr);
    let b1: u32 = load_plane_byte(addr + 0x10000u);
    let b2: u32 = load_plane_byte(addr + 0x20000u);
    let b3: u32 = load_plane_byte(addr + 0x30000u);

    let bit_index: u32 = 7u - (pixel_addr & 7u);
    var shift_val: u32 = 0u;

    switch params.shift_mode {
        case 0u: {
            shift_val = (((b0 >> bit_index) & 1u) |
                        (((b1 >> bit_index) & 1u) << 1u) |
                        (((b2 >> bit_index) & 1u) << 2u) |
                        (((b3 >> bit_index) & 1u) << 3u));
        }
        case 0x20u: {
            // Packed shift mode
            let idx_in_byte: u32 = pixel_addr & 7u;
            var packed: u32 = 0u;
            switch idx_in_byte {
                case 0u: { packed = ((b0 >> 6u) & 0x3u) | ((b2 >> 4u) & 0xCu); }
                case 1u: { packed = ((b0 >> 4u) & 0x3u) | ((b2 >> 2u) & 0xCu); }
                case 2u: { packed = ((b0 >> 2u) & 0x3u) | ((b2 >> 0u) & 0xCu); }
                case 3u: { packed = ((b0 >> 0u) & 0x3u) | ((b2 << 2u) & 0xCu); }
                case 4u: { packed = ((b1 >> 6u) & 0x3u) | ((b3 >> 4u) & 0xCu); }
                case 5u: { packed = ((b1 >> 4u) & 0x3u) | ((b3 >> 2u) & 0xCu); }
                case 6u: { packed = ((b1 >> 2u) & 0x3u) | ((b3 >> 0u) & 0xCu); }
                default: { packed = ((b1 >> 0u) & 0x3u) | ((b3 << 2u) & 0xCu); }
            }
            shift_val = packed;
        }
        default: {
            // 256-color shift mode (0x40 or 0x60)
            let idx_in_byte: u32 = pixel_addr & 7u;
            var packed: u32 = 0u;
            switch idx_in_byte {
                case 0u: { packed = (b0 >> 4u) & 0xFu; }
                case 1u: { packed = b0 & 0xFu; }
                case 2u: { packed = (b1 >> 4u) & 0xFu; }
                case 3u: { packed = b1 & 0xFu; }
                case 4u: { packed = (b2 >> 4u) & 0xFu; }
                case 5u: { packed = b2 & 0xFu; }
                case 6u: { packed = (b3 >> 4u) & 0xFu; }
                default: { packed = b3 & 0xFu; }
            }
            shift_val = packed;
        }
    }

    if(params.pel_width != 0u) {
        let neighbor_pixel: u32 = (pixel_addr & ~3u) | ((pixel_addr & 3u) * 2u + 1u);
        let n_idx_in_byte: u32 = neighbor_pixel & 7u;
        var neighbor_shift: u32 = 0u;

        switch params.shift_mode {
            case 0u: {
                let n_bit: u32 = 7u - n_idx_in_byte;
                neighbor_shift = (((b0 >> n_bit) & 1u) |
                                  (((b1 >> n_bit) & 1u) << 1u) |
                                  (((b2 >> n_bit) & 1u) << 2u) |
                                  (((b3 >> n_bit) & 1u) << 3u));
            }
            case 0x20u: {
                switch n_idx_in_byte {
                    case 0u: { neighbor_shift = ((b0 >> 6u) & 0x3u) | ((b2 >> 4u) & 0xCu); }
                    case 1u: { neighbor_shift = ((b0 >> 4u) & 0x3u) | ((b2 >> 2u) & 0xCu); }
                    case 2u: { neighbor_shift = ((b0 >> 2u) & 0x3u) | ((b2 >> 0u) & 0xCu); }
                    case 3u: { neighbor_shift = ((b0 >> 0u) & 0x3u) | ((b2 << 2u) & 0xCu); }
                    case 4u: { neighbor_shift = ((b1 >> 6u) & 0x3u) | ((b3 >> 4u) & 0xCu); }
                    case 5u: { neighbor_shift = ((b1 >> 4u) & 0x3u) | ((b3 >> 2u) & 0xCu); }
                    case 6u: { neighbor_shift = ((b1 >> 2u) & 0x3u) | ((b3 >> 0u) & 0xCu); }
                    default: { neighbor_shift = ((b1 >> 0u) & 0x3u) | ((b3 << 2u) & 0xCu); }
                }
            }
            default: {
                switch n_idx_in_byte {
                    case 0u: { neighbor_shift = (b0 >> 4u) & 0xFu; }
                    case 1u: { neighbor_shift = b0 & 0xFu; }
                    case 2u: { neighbor_shift = (b1 >> 4u) & 0xFu; }
                    case 3u: { neighbor_shift = b1 & 0xFu; }
                    case 4u: { neighbor_shift = (b2 >> 4u) & 0xFu; }
                    case 5u: { neighbor_shift = b2 & 0xFu; }
                    case 6u: { neighbor_shift = (b3 >> 4u) & 0xFu; }
                    default: { neighbor_shift = b3 & 0xFu; }
                }
            }
        }

        let pair_val: u32 = (shift_val << 4u) | (neighbor_shift & 0xFu);
        return pair_val & 0xFFu;
    }

    return shift_val & 0xFFu;
}

fn rgb_from_15(word: u32) -> vec4<f32> {
    let r = f32(word & 0x1Fu) * (1.0 / 31.0);
    let g = f32((word >> 5u) & 0x1Fu) * (1.0 / 31.0);
    let b = f32((word >> 10u) & 0x1Fu) * (1.0 / 31.0);
    return vec4<f32>(r, g, b, 1.0);
}

fn rgb_from_16(word: u32) -> vec4<f32> {
    let r = f32(word & 0x1Fu) * (1.0 / 31.0);
    let g = f32((word >> 5u) & 0x3Fu) * (1.0 / 63.0);
    let b = f32((word >> 11u) & 0x1Fu) * (1.0 / 31.0);
    return vec4<f32>(r, g, b, 1.0);
}

@compute @workgroup_size(${WORKGROUP_SIZE}, ${WORKGROUP_SIZE})
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    if(gid.x >= params.width || gid.y >= params.height) {
        return;
    }

    let idx: u32 = gid.y * params.width + gid.x;
    var rgba: vec4<f32>;

    switch params.mode {
        case ${MODE_VGA_PLANAR}u: {
            let raw: u32 = vga_planar_color(idx, params.width);
            let color16: u32 = raw & params.color_plane_enable;
            let color_index: u32 = (dac_map[color16] & params.mask) | params.colorset;
            rgba = decode_palette(palette[color_index]);
        }
        case ${MODE_SVGA_15BPP}u: {
            let w: u32 = pixel_indices[idx] & 0xFFFFu;
            rgba = rgb_from_15(w);
        }
        case ${MODE_SVGA_16BPP}u: {
            let w: u32 = pixel_indices[idx] & 0xFFFFu;
            rgba = rgb_from_16(w);
        }
        case ${MODE_SVGA_24BPP}u, ${MODE_SVGA_32BPP}u: {
            let packed: u32 = pixel_indices[idx];
            let r = f32((packed >> 16u) & 0xFFu) / 255.0;
            let g = f32((packed >> 8u) & 0xFFu) / 255.0;
            let b = f32(packed & 0xFFu) / 255.0;
            rgba = vec4<f32>(r, g, b, 1.0);
        }
        case ${MODE_VGA_8BPP}u, ${MODE_SVGA_8BPP}u: {
            let raw: u32 = pixel_indices[idx] & 0xFFu;
            let color_index: u32 = (raw & params.mask) | params.colorset;
            rgba = decode_palette(palette[color_index]);
        }
        case ${MODE_VGA_4BPP}u: {
            let raw: u32 = pixel_indices[idx] & 0xFFu;
            let color16: u32 = raw & params.color_plane_enable;
            let color_index: u32 = (dac_map[color16] & params.mask) | params.colorset;
            rgba = decode_palette(palette[color_index]);
        }
        default: {
            rgba = vec4<f32>(0.0, 0.0, 0.0, 1.0);
        }
    }

    textureStore(out_image, vec2<i32>(i32(gid.x), i32(gid.y)), rgba);
}
`,
    });

    bind_group_layout = device.createBindGroupLayout({
        entries: [
            { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
            { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
            { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
            { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
            { binding: 4, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: "write-only", format: canvas_format, viewDimension: "2d" } },
            { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
        ],
    });

    compute_pipeline = device.createComputePipeline({
        layout: device.createPipelineLayout({ bindGroupLayouts: [bind_group_layout] }),
        compute: { module: shader_module, entryPoint: "main" },
    });

    self.postMessage({ type: "ready" });
}

function render(payload)
{
    if(!device || !compute_pipeline)
    {
        return;
    }

    const texture_width = payload.texture_width;
    const texture_height = payload.texture_height;
    const canvas_format = "rgba8unorm";

    ensure_frame_texture(texture_width, texture_height, canvas_format);

    const pixel_data = payload.pixel_buffer;
    pixel_buffer_gpu = ensure_buffer(pixel_buffer_gpu, pixel_data.byteLength, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, "vga-pixel-buffer");
    queue.writeBuffer(pixel_buffer_gpu, 0, pixel_data);

    palette_buffer_gpu = ensure_buffer(palette_buffer_gpu, payload.palette.byteLength, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, "vga-palette-buffer");
    queue.writeBuffer(palette_buffer_gpu, 0, payload.palette);

    dac_map_buffer_gpu = ensure_buffer(dac_map_buffer_gpu, payload.dac_map.byteLength, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, "vga-dac-map");
    queue.writeBuffer(dac_map_buffer_gpu, 0, payload.dac_map);

    if(payload.planes)
    {
        plane_buffer_gpu = ensure_buffer(plane_buffer_gpu, payload.planes.byteLength, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, "vga-planes");
        queue.writeBuffer(plane_buffer_gpu, 0, payload.planes);
    }
    else
    {
        plane_buffer_gpu = null;
    }

    params_array[0] = texture_width;
    params_array[1] = texture_height;
    params_array[2] = payload.mask >>> 0;
    params_array[3] = payload.colorset >>> 0;
    params_array[4] = payload.mode;
    params_array[5] = payload.color_plane_enable >>> 0;
    params_array[6] = payload.addr_shift >>> 0;
    params_array[7] = payload.addr_substitution >>> 0;
    params_array[8] = payload.shift_mode >>> 0;
    params_array[9] = payload.pel_width >>> 0;
    params_array[10] = payload.start_address >>> 0;

    params_buffer_gpu = ensure_buffer(params_buffer_gpu, params_array.byteLength, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, "vga-params");
    queue.writeBuffer(params_buffer_gpu, 0, params_array);

    const bind_group = device.createBindGroup({
        layout: bind_group_layout,
        entries: [
            { binding: 0, resource: { buffer: pixel_buffer_gpu } },
            { binding: 1, resource: { buffer: palette_buffer_gpu } },
            { binding: 2, resource: { buffer: dac_map_buffer_gpu } },
            { binding: 3, resource: { buffer: plane_buffer_gpu ?? pixel_buffer_gpu } },
            { binding: 4, resource: frame_texture.createView() },
            { binding: 5, resource: { buffer: params_buffer_gpu } },
        ],
    });

    const encoder = device.createCommandEncoder();
    const compute = encoder.beginComputePass();
    compute.setPipeline(compute_pipeline);
    compute.setBindGroup(0, bind_group);
    const workgroups_x = Math.ceil(texture_width / WORKGROUP_SIZE);
    const workgroups_y = Math.ceil(texture_height / WORKGROUP_SIZE);
    compute.dispatchWorkgroups(workgroups_x, workgroups_y);
    compute.end();

    const swap_texture = canvas_context.getCurrentTexture();

    for(const layer of payload.layers)
    {
        let src_x = layer.buffer_x;
        let src_y = layer.buffer_y;
        let dst_x = layer.screen_x;
        let dst_y = layer.screen_y;
        let copy_width = layer.buffer_width;
        let copy_height = layer.buffer_height;

        if(dst_x < 0)
        {
            const delta = -dst_x;
            src_x += delta;
            copy_width -= delta;
            dst_x = 0;
        }
        if(dst_y < 0)
        {
            const delta = -dst_y;
            src_y += delta;
            copy_height -= delta;
            dst_y = 0;
        }

        copy_width = Math.min(copy_width, swap_texture.width - dst_x, frame_texture_size.width - src_x);
        copy_height = Math.min(copy_height, swap_texture.height - dst_y, frame_texture_size.height - src_y);

        if(copy_width <= 0 || copy_height <= 0)
        {
            continue;
        }

        encoder.copyTextureToTexture(
            { texture: frame_texture, origin: { x: src_x, y: src_y, z: 0 } },
            { texture: swap_texture, origin: { x: dst_x, y: dst_y, z: 0 } },
            { width: copy_width, height: copy_height, depthOrArrayLayers: 1 },
        );
    }

    queue.submit([encoder.finish()]);
}

self.onmessage = async ev =>
{
    const { data } = ev;
    if(!data || !data.type) return;

    switch(data.type)
    {
        case "probe":
            try
            {
                const adapter = await navigator.gpu?.requestAdapter();
                self.postMessage({ type: "probe-result", ok: !!adapter });
            }
            catch(e)
            {
                self.postMessage({ type: "probe-result", ok: false, error: e?.message });
            }
            break;
        case "init":
            await initRenderer(data);
            break;
        case "resize":
            if(canvas_context && device)
            {
                if(typeof data.width === "number" && typeof data.height === "number")
                {
                    canvas.width = data.width;
                    canvas.height = data.height;
                }
                canvas_context.configure({
                    device,
                    format: "rgba8unorm",
                    alphaMode: "opaque",
                    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_DST,
                });
            }
            break;
        case "render":
            render(data.payload);
            break;
        default:
            break;
    }
};
