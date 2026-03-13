// Offloads VGA planar replot + palette conversion to a worker to keep the main thread responsive.
const VGA_BANK_SIZE = 64 * 1024;
const VGA_PIXEL_BUFFER_SIZE = 8 * VGA_BANK_SIZE;

function vga_addr_shift_count(attribute_mode, underline_location_register, crtc_mode)
{
    let shift_count = 0x80;
    shift_count += ~underline_location_register & crtc_mode & 0x40;
    shift_count -= underline_location_register & 0x40;
    shift_count -= attribute_mode & 0x40;
    return shift_count >>> 6;
}

function render_vga_planar(msg)
{
    const virtual_width = msg.virtual_width | 0;
    if(!virtual_width)
    {
        self.postMessage({ type: "vga-render-done", generation: msg.generation });
        return;
    }

    const base_start = msg.pixel_base_start | 0;
    const pixel_values = new Uint8Array(msg.pixel_seed);
    const palette = new Int32Array(msg.palette);
    const dac_map = new Uint8Array(msg.dac_map);
    const plane0 = new Uint8Array(msg.plane0);
    const plane1 = new Uint8Array(msg.plane1);
    const plane2 = new Uint8Array(msg.plane2);
    const plane3 = new Uint8Array(msg.plane3);

    const diff_plot_min = Math.max(0, msg.diff_plot_min | 0);
    const diff_plot_max = Math.min(msg.diff_plot_max | 0, VGA_PIXEL_BUFFER_SIZE - 1);
    const diff_addr_min = Math.max(0, msg.diff_addr_min | 0);
    const diff_addr_max = Math.min(msg.diff_addr_max | 0, VGA_PIXEL_BUFFER_SIZE - 1);

    const addr_shift = vga_addr_shift_count(msg.attribute_mode | 0, msg.underline_location_register | 0, msg.crtc_mode | 0);
    const addr_substitution = ~(msg.crtc_mode | 0) & 0x3;
    const shift_mode = (msg.planar_mode | 0) & 0x60;
    const pel_width = (msg.attribute_mode | 0) & 0x40;

    const shift_loads = new Uint8Array(8);

    for(let pixel_addr = diff_plot_min; pixel_addr <= diff_plot_max;)
    {
        let addr = pixel_addr >>> addr_shift;
        if(addr_substitution)
        {
            let row = pixel_addr / virtual_width | 0;
            let col = pixel_addr - virtual_width * row;

            switch(addr_substitution)
            {
                case 0x1:
                    addr = (row & 0x1) << 13;
                    row >>>= 1;
                    break;
                case 0x2:
                    addr = (row & 0x1) << 14;
                    row >>>= 1;
                    break;
                case 0x3:
                    addr = (row & 0x3) << 13;
                    row >>>= 2;
                    break;
            }

            addr |= (row * virtual_width + col >>> addr_shift) + (msg.start_address | 0);
        }

        if(addr < 0 || addr >= plane0.length)
        {
            pixel_addr += pel_width ? 4 : 8;
            continue;
        }

        let byte0 = plane0[addr];
        let byte1 = plane1[addr];
        let byte2 = plane2[addr];
        let byte3 = plane3[addr];

        switch(shift_mode)
        {
            case 0x00:
                byte0 <<= 0;
                byte1 <<= 1;
                byte2 <<= 2;
                byte3 <<= 3;

                for(let i = 7; i >= 0; i--)
                {
                    shift_loads[7 - i] =
                        (byte0 >> i & 1) |
                        (byte1 >> i & 2) |
                        (byte2 >> i & 4) |
                        (byte3 >> i & 8);
                }
                break;

            case 0x20:
                shift_loads[0] = (byte0 >> 6 & 0x3) | (byte2 >> 4 & 0xC);
                shift_loads[1] = (byte0 >> 4 & 0x3) | (byte2 >> 2 & 0xC);
                shift_loads[2] = (byte0 >> 2 & 0x3) | (byte2 >> 0 & 0xC);
                shift_loads[3] = (byte0 >> 0 & 0x3) | (byte2 << 2 & 0xC);

                shift_loads[4] = (byte1 >> 6 & 0x3) | (byte3 >> 4 & 0xC);
                shift_loads[5] = (byte1 >> 4 & 0x3) | (byte3 >> 2 & 0xC);
                shift_loads[6] = (byte1 >> 2 & 0x3) | (byte3 >> 0 & 0xC);
                shift_loads[7] = (byte1 >> 0 & 0x3) | (byte3 << 2 & 0xC);
                break;

            case 0x40:
            case 0x60:
                shift_loads[0] = byte0 >> 4 & 0xF;
                shift_loads[1] = byte0 >> 0 & 0xF;
                shift_loads[2] = byte1 >> 4 & 0xF;
                shift_loads[3] = byte1 >> 0 & 0xF;
                shift_loads[4] = byte2 >> 4 & 0xF;
                shift_loads[5] = byte2 >> 0 & 0xF;
                shift_loads[6] = byte3 >> 4 & 0xF;
                shift_loads[7] = byte3 >> 0 & 0xF;
                break;
        }

        if(pel_width)
        {
            for(let i = 0, j = 0; i < 4; i++, pixel_addr++, j += 2)
            {
                pixel_values[pixel_addr - base_start] = (shift_loads[j] << 4) | shift_loads[j + 1];
            }
        }
        else
        {
            for(let i = 0; i < 8; i++, pixel_addr++)
            {
                pixel_values[pixel_addr - base_start] = shift_loads[i];
            }
        }
    }

    const rgba_len = diff_addr_max >= diff_addr_min ? (diff_addr_max - diff_addr_min + 1) : 0;
    const rgba = new Int32Array(rgba_len);

    let mask = 0xFF;
    let colorset = 0x00;
    if(msg.attribute_mode & 0x80)
    {
        mask &= 0xCF;
        colorset |= (msg.color_select << 4) & 0x30;
    }

    const is_8bpp = !!(msg.attribute_mode & 0x40);
    if(!is_8bpp)
    {
        mask &= 0x3F;
        colorset |= (msg.color_select << 4) & 0xC0;
    }

    for(let pixel_addr = diff_addr_min; pixel_addr <= diff_addr_max; pixel_addr++)
    {
        const px = pixel_values[pixel_addr - base_start];
        let color256;
        if(is_8bpp)
        {
            color256 = (px & mask) | colorset;
        }
        else
        {
            const color16 = px & msg.color_plane_enable;
            color256 = (dac_map[color16] & mask) | colorset;
        }

        const color = palette[color256];
        rgba[pixel_addr - diff_addr_min] = (color & 0xFF00) | (color << 16) | (color >>> 16) | 0xFF000000;
    }

    // Prepare optional WebGPU payload when requested
    if(msg.need_webgpu)
    {
        const pixel_count = msg.texture_width * msg.texture_height;
        const pixel_buffer_u32 = new Uint32Array(pixel_count);
        pixel_buffer_u32.set(pixel_values.subarray(0, Math.min(pixel_count, pixel_values.length)));

        const palette_u32 = new Uint32Array(palette);
        const dac_map_u32 = new Uint32Array(0x10);
        for(let i = 0; i < dac_map.length; i++) dac_map_u32[i] = dac_map[i];

        const planes = new Uint8Array(4 * VGA_BANK_SIZE);
        planes.set(plane0, 0 * VGA_BANK_SIZE);
        planes.set(plane1, 1 * VGA_BANK_SIZE);
        planes.set(plane2, 2 * VGA_BANK_SIZE);
        planes.set(plane3, 3 * VGA_BANK_SIZE);

        const payload = {
            pixel_buffer: pixel_buffer_u32,
            palette: palette_u32,
            dac_map: dac_map_u32,
            planes,
            mask,
            colorset,
            mode: 0,
            color_plane_enable: msg.color_plane_enable,
            texture_width: msg.texture_width,
            texture_height: msg.texture_height,
            addr_shift,
            addr_substitution,
            shift_mode,
            pel_width,
            start_address: msg.start_address,
            layers: msg.layers || [],
        };

        self.postMessage({
            type: "vga-webgpu-done",
            generation: msg.generation,
            payload,
        }, [
            pixel_buffer_u32.buffer,
            palette_u32.buffer,
            dac_map_u32.buffer,
            planes.buffer,
        ]);
        return;
    }

    self.postMessage({
        type: "vga-render-done",
        generation: msg.generation,
        pixel_base_start: base_start,
        pixel_values: pixel_values.buffer,
        rgba_start: diff_addr_min,
        rgba: rgba.buffer,
    }, [pixel_values.buffer, rgba.buffer]);
}

function render_svga(msg)
{
    const width = msg.width | 0;
    const height = msg.height | 0;
    if(!width || !height)
    {
        self.postMessage({ type: "svga-render-done", generation: msg.generation });
        return;
    }

    const bpp = msg.bpp | 0;
    const src = new Uint8Array(msg.svga_memory);
    const rows = msg.max_y - msg.min_y;
    const rgba = new Int32Array(width * rows);

    if(bpp === 8)
    {
        const palette = new Int32Array(msg.palette);
        for(let i = 0; i < src.length && i < rgba.length; i++)
        {
            const color = palette[src[i]];
            rgba[i] = (color & 0xFF00) | (color << 16) | (color >>> 16) | 0xFF000000;
        }
    }
    else if(bpp === 15 || bpp === 16)
    {
        const bytes_per_pixel = 2;
        for(let i = 0, px = 0; i + 1 < src.length && px < rgba.length; i += bytes_per_pixel, px++)
        {
            const value = src[i] | (src[i + 1] << 8);
            let r, g, b;
            if(bpp === 15)
            {
                r = (value >> 10) & 0x1F;
                g = (value >> 5) & 0x1F;
                b = value & 0x1F;
                r = (r << 3) | (r >> 2);
                g = (g << 3) | (g >> 2);
                b = (b << 3) | (b >> 2);
            }
            else
            {
                r = (value >> 11) & 0x1F;
                g = (value >> 5) & 0x3F;
                b = value & 0x1F;
                r = (r << 3) | (r >> 2);
                g = (g << 2) | (g >> 4);
                b = (b << 3) | (b >> 2);
            }
            rgba[px] = 0xFF000000 | (r << 16) | (g << 8) | b;
        }
    }
    else if(bpp === 24)
    {
        for(let i = 0, px = 0; i + 2 < src.length && px < rgba.length; i += 3, px++)
        {
            const b = src[i];
            const g = src[i + 1];
            const r = src[i + 2];
            rgba[px] = 0xFF000000 | (r << 16) | (g << 8) | b;
        }
    }
    else if(bpp === 32)
    {
        for(let i = 0, px = 0; i + 3 < src.length && px < rgba.length; i += 4, px++)
        {
            const b = src[i];
            const g = src[i + 1];
            const r = src[i + 2];
            rgba[px] = 0xFF000000 | (r << 16) | (g << 8) | b;
        }
    }

    self.postMessage({
        type: "svga-render-done",
        generation: msg.generation,
        rgba_start: msg.min_y * width,
        min_y: msg.min_y,
        max_y: msg.max_y,
        rgba: rgba.buffer,
    }, [rgba.buffer]);
}

self.onmessage = e =>
{
    const msg = e.data;
    if(!msg || !msg.type)
    {
        return;
    }

    switch(msg.type)
    {
        case "vga-render":
            render_vga_planar(msg);
            break;
        case "svga-render":
            render_svga(msg);
            break;
        default:
            break;
    }
};
