import { dbg_assert } from "../log.js";
import { get_charmap } from "../lib.js";

// Draws entire buffer and visualizes the layers that would be drawn
export const DEBUG_SCREEN_LAYERS = DEBUG && false;

/**
 * Adapter to use visual screen in browsers (in contrast to node)
 * @constructor
 * @param {Object} options
 * @param {function()} screen_fill_buffer
 */
export function ScreenAdapter(options, screen_fill_buffer)
{
    const screen_container = options.container;
    this.screen_fill_buffer = screen_fill_buffer;

    console.assert(screen_container, "options.container must be provided");

    const MODE_TEXT = 0;
    const MODE_GRAPHICAL = 1;
    const MODE_GRAPHICAL_TEXT = 2;

    const CHARACTER_INDEX = 0;
    const FLAGS_INDEX = 1;
    const BG_COLOR_INDEX = 2;
    const FG_COLOR_INDEX = 3;
    const TEXT_BUF_COMPONENT_SIZE = 4;

    const FLAG_BLINKING = 0x01;
    const FLAG_FONT_PAGE_B = 0x02;

    this.FLAG_BLINKING = FLAG_BLINKING;
    this.FLAG_FONT_PAGE_B = FLAG_FONT_PAGE_B;

    let graphic_screen = screen_container.getElementsByTagName("canvas")[0];
    if(!graphic_screen)
    {
        graphic_screen = document.createElement("canvas");
        screen_container.appendChild(graphic_screen);
    }
    const graphic_context = graphic_screen.getContext("2d", { alpha: false });
    this.graphic_screen = graphic_screen;
    this.graphic_context = graphic_context;

    let text_screen = screen_container.getElementsByTagName("div")[0];
    if(!text_screen)
    {
        text_screen = document.createElement("div");
        screen_container.appendChild(text_screen);
    }

    const cursor_element = document.createElement("div");

    var
        /** @type {number} */
        cursor_row,

        /** @type {number} */
        cursor_col,

        /** @type {number} */
        scale_x = options.scale !== undefined ? options.scale : 1,

        /** @type {number} */
        scale_y = options.scale !== undefined ? options.scale : 1,

        base_scale = 1,

        changed_rows,

        // current display mode: MODE_GRAPHICAL or either MODE_TEXT/MODE_GRAPHICAL_TEXT
        mode,

        // Index 0: ASCII code
        // Index 1: Flags bitset (see FLAG_...)
        // Index 2: Background color
        // Index 3: Foreground color
        text_mode_data,

        // number of columns
        text_mode_width,

        // number of rows
        text_mode_height,

        // graphical text mode's offscreen canvas contexts
        offscreen_context,
        offscreen_extra_context,

        // fonts
        font_context,
        font_image_data,
        font_is_visible = new Int8Array(8 * 256),
        font_height,
        font_width,
        font_width_9px,
        font_width_dbl,
        font_copy_8th_col,
        font_page_a = 0,
        font_page_b = 0,

        // blink state
        blink_visible,
        tm_last_update = 0,

        // cursor attributes
        cursor_start,
        cursor_end,
        cursor_enabled,

        // 8-bit-text to Unicode character map
        charmap = get_charmap(options.encoding),

        // render loop state
        timer_id = 0,
        paused = false;

    // 0x12345 -> "#012345"
    function number_as_color(n)
    {
        n = n.toString(16);
        return "#" + "0".repeat(6 - n.length) + n;
    }

    function render_font_bitmap(vga_bitmap)
    {
        // - Browsers impose limts on the X- and Y-axes of bitmaps (typically around 8 to 32k).
        //   Draw the 8 VGA font pages of 256 glyphs in 8 rows of 256 columns, this results
        //   in 2048, 2304 or 4096px on the X-axis (for 8, 9 or 16px VGA font width, resp.).
        //   This 2d layout is also convenient for glyph lookup when rendering text.
        // - Font bitmap pixels are black and either fully opaque (alpha 255) or fully transparent (0).
        const bitmap_width = font_width * 256;
        const bitmap_height = font_height * 8;

        let font_canvas = font_context ? font_context.canvas : null;
        if(!font_canvas || font_canvas.width !== bitmap_width || font_canvas.height !== bitmap_height)
        {
            if(!font_canvas)
            {
                font_canvas = new OffscreenCanvas(bitmap_width, bitmap_height);
                font_context = font_canvas.getContext("2d");
            }
            else
            {
                font_canvas.width = bitmap_width;
                font_canvas.height = bitmap_height;
            }
            font_image_data = font_context.createImageData(bitmap_width, bitmap_height);
        }

        const font_bitmap = font_image_data.data;
        let i_dst = 0, is_visible;
        const put_bit = font_width_dbl ?
            function(value)
            {
                is_visible = is_visible || value;
                font_bitmap[i_dst + 3] = value;
                font_bitmap[i_dst + 7] = value;
                i_dst += 8;
            } :
            function(value)
            {
                is_visible = is_visible || value;
                font_bitmap[i_dst + 3] = value;
                i_dst += 4;
            };

        // move i_vga from end of glyph to start of next glyph
        const vga_inc_chr = 32 - font_height;
        // move i_dst from end of font page (bitmap row) to start of next font page
        const dst_inc_row = bitmap_width * (font_height - 1) * 4;
        // move i_dst from end of glyph (bitmap column) to start of next glyph
        const dst_inc_col = (font_width - bitmap_width * font_height) * 4;
        // move i_dst from end of a glyph's scanline to start of its next scanline
        const dst_inc_line = font_width * 255 * 4;

        for(let i_chr_all = 0, i_vga = 0; i_chr_all < 2048; ++i_chr_all, i_vga += vga_inc_chr, i_dst += dst_inc_col)
        {
            const i_chr = i_chr_all % 256;
            if(i_chr_all && !i_chr)
            {
                i_dst += dst_inc_row;
            }
            is_visible = false;
            for(let i_line = 0; i_line < font_height; ++i_line, ++i_vga, i_dst += dst_inc_line)
            {
                const line_bits = vga_bitmap[i_vga];
                for(let i_bit = 0x80; i_bit > 0; i_bit >>= 1)
                {
                    put_bit(line_bits & i_bit ? 255 : 0);
                }
                if(font_width_9px)
                {
                    put_bit(font_copy_8th_col && i_chr >= 0xC0 && i_chr <= 0xDF && line_bits & 1 ? 255 : 0);
                }
            }
            font_is_visible[i_chr_all] = is_visible ? 1 : 0;
        }

        font_context.putImageData(font_image_data, 0, 0);
    }

    function render_changed_rows()
    {
        const font_canvas = font_context.canvas;
        const offscreen_extra_canvas = offscreen_extra_context.canvas;
        const txt_row_size = text_mode_width * TEXT_BUF_COMPONENT_SIZE;
        const gfx_width = text_mode_width * font_width;
        const row_extra_1_y = 0;
        const row_extra_2_y = font_height;

        let n_rows_rendered = 0;
        for(let row_i = 0, row_y = 0, txt_i = 0; row_i < text_mode_height; ++row_i, row_y += font_height)
        {
            if(!changed_rows[row_i])
            {
                txt_i += txt_row_size;
                continue;
            }
            ++n_rows_rendered;

            // clear extra row 2
            offscreen_extra_context.clearRect(0, row_extra_2_y, gfx_width, font_height);

            let fg_rgba, fg_x, bg_rgba, bg_x;
            for(let col_x = 0; col_x < gfx_width; col_x += font_width, txt_i += TEXT_BUF_COMPONENT_SIZE)
            {
                const chr = text_mode_data[txt_i + CHARACTER_INDEX];
                const chr_flags = text_mode_data[txt_i + FLAGS_INDEX];
                const chr_bg_rgba = text_mode_data[txt_i + BG_COLOR_INDEX];
                const chr_fg_rgba = text_mode_data[txt_i + FG_COLOR_INDEX];
                const chr_font_page = chr_flags & FLAG_FONT_PAGE_B ? font_page_b : font_page_a;
                const chr_visible = (!(chr_flags & FLAG_BLINKING) || blink_visible) && font_is_visible[(chr_font_page << 8) + chr];

                if(bg_rgba !== chr_bg_rgba)
                {
                    if(bg_rgba !== undefined)
                    {
                        // draw opaque block of background color into offscreen_context
                        offscreen_context.fillStyle = number_as_color(bg_rgba);
                        offscreen_context.fillRect(bg_x, row_y, col_x - bg_x, font_height);
                    }
                    bg_rgba = chr_bg_rgba;
                    bg_x = col_x;
                }

                if(fg_rgba !== chr_fg_rgba)
                {
                    if(fg_rgba !== undefined)
                    {
                        // draw opaque block of foreground color into extra row 1
                        offscreen_extra_context.fillStyle = number_as_color(fg_rgba);
                        offscreen_extra_context.fillRect(fg_x, row_extra_1_y, col_x - fg_x, font_height);
                    }
                    fg_rgba = chr_fg_rgba;
                    fg_x = col_x;
                }

                if(chr_visible)
                {
                    // copy transparent glyphs into extra row 2
                    offscreen_extra_context.drawImage(font_canvas,
                        chr * font_width, chr_font_page * font_height, font_width, font_height,
                        col_x, row_extra_2_y, font_width, font_height);
                }
            }

            // draw rightmost block of foreground color into extra row 1
            offscreen_extra_context.fillStyle = number_as_color(fg_rgba);
            offscreen_extra_context.fillRect(fg_x, row_extra_1_y, gfx_width - fg_x, font_height);

            // combine extra row 1 (colors) and 2 (glyphs) into extra row 1 (colored glyphs)
            offscreen_extra_context.globalCompositeOperation = "destination-in";
            offscreen_extra_context.drawImage(offscreen_extra_canvas,
                0, row_extra_2_y, gfx_width, font_height,
                0, row_extra_1_y, gfx_width, font_height);
            offscreen_extra_context.globalCompositeOperation = "source-over";

            // draw rightmost block of background color into offscreen_context
            offscreen_context.fillStyle = number_as_color(bg_rgba);
            offscreen_context.fillRect(bg_x, row_y, gfx_width - bg_x, font_height);

            // copy colored glyphs from extra row 1 into offscreen_context (on top of background colors)
            offscreen_context.drawImage(offscreen_extra_canvas,
                0, row_extra_1_y, gfx_width, font_height,
                0, row_y, gfx_width, font_height);
        }

        if(n_rows_rendered)
        {
            if(blink_visible && cursor_enabled && changed_rows[cursor_row])
            {
                const cursor_txt_i = (cursor_row * text_mode_width + cursor_col) * TEXT_BUF_COMPONENT_SIZE;
                const cursor_rgba = text_mode_data[cursor_txt_i + FG_COLOR_INDEX];
                offscreen_context.fillStyle = number_as_color(cursor_rgba);
                offscreen_context.fillRect(
                    cursor_col * font_width,
                    cursor_row * font_height + cursor_start,
                    font_width,
                    cursor_end - cursor_start + 1);
            }
            changed_rows.fill(0);
        }

        return n_rows_rendered;
    }

    function mark_blinking_rows_dirty()
    {
        const txt_row_size = text_mode_width * TEXT_BUF_COMPONENT_SIZE;
        for(let row_i = 0, txt_i = 0; row_i < text_mode_height; ++row_i)
        {
            if(changed_rows[row_i])
            {
                txt_i += txt_row_size;
                continue;
            }
            for(let col_i = 0; col_i < text_mode_width; ++col_i, txt_i += TEXT_BUF_COMPONENT_SIZE)
            {
                if(text_mode_data[txt_i + FLAGS_INDEX] & FLAG_BLINKING)
                {
                    changed_rows[row_i] = 1;
                    txt_i += txt_row_size - col_i * TEXT_BUF_COMPONENT_SIZE;
                    break;
                }
            }
        }
    }

    this.init = function()
    {
        // setup text mode cursor DOM element
        cursor_element.classList.add("cursor");
        cursor_element.style.position = "absolute";
        cursor_element.style.backgroundColor = "#ccc";
        cursor_element.style.width = "7px";
        cursor_element.style.display = "inline-block";

        // initialize display mode and size to 80x25 text with 9x16 font
        this.set_mode(false);
        this.set_size_text(80, 25);
        if(mode === MODE_GRAPHICAL_TEXT)
        {
            this.set_size_graphical(720, 400, 720, 400);
        }

        // initialize CSS scaling
        this.set_scale(scale_x, scale_y);

        this.timer();
    };

    this.make_screenshot = function()
    {
        const image = new Image();

        if(mode === MODE_GRAPHICAL || mode === MODE_GRAPHICAL_TEXT)
        {
            image.src = graphic_screen.toDataURL("image/png");
        }
        else
        {
            // Default 720x400, but can be [8, 16] at 640x400
            const char_size = [9, 16];

            const canvas = document.createElement("canvas");
            canvas.width = text_mode_width * char_size[0];
            canvas.height = text_mode_height * char_size[1];
            const context = canvas.getContext("2d");
            context.imageSmoothingEnabled = false;
            context.font = window.getComputedStyle(text_screen).font;
            context.textBaseline = "top";

            for(let y = 0; y < text_mode_height; y++)
            {
                for(let x = 0; x < text_mode_width; x++)
                {
                    const index = (y * text_mode_width + x) * TEXT_BUF_COMPONENT_SIZE;
                    const character = text_mode_data[index + CHARACTER_INDEX];
                    const bg_color = text_mode_data[index + BG_COLOR_INDEX];
                    const fg_color = text_mode_data[index + FG_COLOR_INDEX];

                    context.fillStyle = number_as_color(bg_color);
                    context.fillRect(x * char_size[0], y * char_size[1], char_size[0], char_size[1]);
                    context.fillStyle = number_as_color(fg_color);
                    context.fillText(charmap[character], x * char_size[0], y * char_size[1]);
                }
            }

            if(cursor_element.style.display !== "none" && cursor_row < text_mode_height && cursor_col < text_mode_width)
            {
                context.fillStyle = cursor_element.style.backgroundColor;
                context.fillRect(
                    cursor_col * char_size[0],
                    cursor_row * char_size[1] + parseInt(cursor_element.style.marginTop, 10),
                    parseInt(cursor_element.style.width, 10),
                    parseInt(cursor_element.style.height, 10)
                );
            }

            image.src = canvas.toDataURL("image/png");
        }
        return image;
    };

    this.put_char = function(row, col, chr, flags, bg_color, fg_color)
    {
        dbg_assert(row >= 0 && row < text_mode_height);
        dbg_assert(col >= 0 && col < text_mode_width);
        dbg_assert(chr >= 0 && chr < 0x100);

        const p = TEXT_BUF_COMPONENT_SIZE * (row * text_mode_width + col);

        text_mode_data[p + CHARACTER_INDEX] = chr;
        text_mode_data[p + FLAGS_INDEX] = flags;
        text_mode_data[p + BG_COLOR_INDEX] = bg_color;
        text_mode_data[p + FG_COLOR_INDEX] = fg_color;

        changed_rows[row] = 1;
    };

    this.timer = function()
    {
        timer_id = requestAnimationFrame(() => this.update_screen());
    };

    this.update_screen = function()
    {
        if(!paused)
        {
            if(mode === MODE_TEXT)
            {
                this.update_text();
            }
            else if(mode === MODE_GRAPHICAL)
            {
                this.update_graphical();
            }
            else
            {
                this.update_graphical_text();
            }
        }
        this.timer();
    };

    this.update_text = function()
    {
        for(var i = 0; i < text_mode_height; i++)
        {
            if(changed_rows[i])
            {
                this.text_update_row(i);
                changed_rows[i] = 0;
            }
        }
    };

    this.update_graphical = function()
    {
        this.screen_fill_buffer();
    };

    this.update_graphical_text = function()
    {
        if(offscreen_context)
        {
            // toggle cursor and blinking character visibility at a frequency of ~3.75hz
            const tm_now = performance.now();
            if(tm_now - tm_last_update > 266)
            {
                blink_visible = !blink_visible;
                if(cursor_enabled)
                {
                    changed_rows[cursor_row] = 1;
                }
                mark_blinking_rows_dirty();
                tm_last_update = tm_now;
            }
            // copy to DOM canvas only if anything new was rendered
            if(render_changed_rows())
            {
                graphic_context.drawImage(offscreen_context.canvas, 0, 0);
            }
        }
    };

    this.destroy = function()
    {
        if(timer_id)
        {
            cancelAnimationFrame(timer_id);
            timer_id = 0;
        }
    };

    this.pause = function()
    {
        paused = true;
        cursor_element.classList.remove("blinking-cursor");
    };

    this.continue = function()
    {
        paused = false;
        cursor_element.classList.add("blinking-cursor");
    };

    this.set_mode = function(graphical)
    {
        mode = graphical ? MODE_GRAPHICAL : (options.use_graphical_text ? MODE_GRAPHICAL_TEXT : MODE_TEXT);

        if(mode === MODE_TEXT)
        {
            text_screen.style.display = "block";
            graphic_screen.style.display = "none";
        }
        else
        {
            text_screen.style.display = "none";
            graphic_screen.style.display = "block";

            if(mode === MODE_GRAPHICAL_TEXT && changed_rows)
            {
                changed_rows.fill(1);
            }
        }
    };

    this.set_font_bitmap = function(height, width_9px, width_dbl, copy_8th_col, vga_bitmap, vga_bitmap_changed)
    {
        const width = width_dbl ? 16 : (width_9px ? 9 : 8);
        if(font_height !== height || font_width !== width || font_width_9px !== width_9px ||
            font_width_dbl !== width_dbl || font_copy_8th_col !== copy_8th_col ||
            vga_bitmap_changed)
        {
            const size_changed = font_width !== width || font_height !== height;
            font_height = height;
            font_width = width;
            font_width_9px = width_9px;
            font_width_dbl = width_dbl;
            font_copy_8th_col = copy_8th_col;
            if(mode === MODE_GRAPHICAL_TEXT)
            {
                render_font_bitmap(vga_bitmap);
                changed_rows.fill(1);
                if(size_changed)
                {
                    this.set_size_graphical_text();
                }
            }
        }
    };

    this.set_font_page = function(page_a, page_b)
    {
        if(font_page_a !== page_a || font_page_b !== page_b)
        {
            font_page_a = page_a;
            font_page_b = page_b;
            changed_rows.fill(1);
        }
    };

    this.clear_screen = function()
    {
        graphic_context.fillStyle = "#000";
        graphic_context.fillRect(0, 0, graphic_screen.width, graphic_screen.height);
    };

    this.set_size_graphical_text = function()
    {
        if(!font_context)
        {
            return;
        }

        const gfx_width = font_width * text_mode_width;
        const gfx_height = font_height * text_mode_height;
        const offscreen_extra_height = font_height * 2;

        if(!offscreen_context || offscreen_context.canvas.width !== gfx_width ||
            offscreen_context.canvas.height !== gfx_height ||
            offscreen_extra_context.canvas.height !== offscreen_extra_height)
        {
            // resize offscreen canvases
            if(!offscreen_context)
            {
                const offscreen_canvas = new OffscreenCanvas(gfx_width, gfx_height);
                offscreen_context = offscreen_canvas.getContext("2d", { alpha: false });
                const offscreen_extra_canvas = new OffscreenCanvas(gfx_width, offscreen_extra_height);
                offscreen_extra_context = offscreen_extra_canvas.getContext("2d");
            }
            else
            {
                offscreen_context.canvas.width = gfx_width;
                offscreen_context.canvas.height = gfx_height;
                offscreen_extra_context.canvas.width = gfx_width;
                offscreen_extra_context.canvas.height = offscreen_extra_height;
            }

            // resize DOM canvas graphic_screen
            this.set_size_graphical(gfx_width, gfx_height, gfx_width, gfx_height);

            changed_rows.fill(1);
        }
    };

    /**
     * @param {number} cols
     * @param {number} rows
     */
    this.set_size_text = function(cols, rows)
    {
        if(cols === text_mode_width && rows === text_mode_height)
        {
            return;
        }

        changed_rows = new Int8Array(rows);
        text_mode_data = new Int32Array(cols * rows * TEXT_BUF_COMPONENT_SIZE);

        text_mode_width = cols;
        text_mode_height = rows;

        if(mode === MODE_TEXT)
        {
            while(text_screen.childNodes.length > rows)
            {
                text_screen.removeChild(text_screen.firstChild);
            }

            while(text_screen.childNodes.length < rows)
            {
                text_screen.appendChild(document.createElement("div"));
            }

            for(var i = 0; i < rows; i++)
            {
                this.text_update_row(i);
            }

            update_scale_text();
        }
        else if(mode === MODE_GRAPHICAL_TEXT)
        {
            this.set_size_graphical_text();
        }
    };

    this.set_size_graphical = function(width, height, buffer_width, buffer_height)
    {
        if(DEBUG_SCREEN_LAYERS)
        {
            // Draw the entire buffer. Useful for debugging
            // panning / page flipping / screen splitting code for both
            // v86 developers and os developers
            width = buffer_width;
            height = buffer_height;
        }

        graphic_screen.style.display = "block";

        graphic_screen.width = width;
        graphic_screen.height = height;

        // graphic_context must be reconfigured whenever its graphic_screen is resized
        graphic_context.imageSmoothingEnabled = false;

        // add some scaling to tiny resolutions
        if(width <= 640 &&
            width * 2 < window.innerWidth * window.devicePixelRatio &&
            height * 2 < window.innerHeight * window.devicePixelRatio)
        {
            base_scale = 2;
        }
        else
        {
            base_scale = 1;
        }

        update_scale_graphic();
    };

    this.set_scale = function(s_x, s_y)
    {
        scale_x = s_x;
        scale_y = s_y;

        update_scale_text();
        update_scale_graphic();
    };

    function update_scale_text()
    {
        elem_set_scale(text_screen, scale_x, scale_y, true);
    }

    function update_scale_graphic()
    {
        elem_set_scale(graphic_screen, scale_x * base_scale, scale_y * base_scale, false);
    }

    function elem_set_scale(elem, scale_x, scale_y, use_scale)
    {
        if(!scale_x || !scale_y)
        {
            return;
        }

        elem.style.width = "";
        elem.style.height = "";

        if(use_scale)
        {
            elem.style.transform = "";
        }

        var rectangle = elem.getBoundingClientRect();

        if(use_scale)
        {
            var scale_str = "";

            scale_str += scale_x === 1 ? "" : " scaleX(" + scale_x + ")";
            scale_str += scale_y === 1 ? "" : " scaleY(" + scale_y + ")";

            elem.style.transform = scale_str;
        }
        else
        {
            // unblur non-fractional scales
            if(scale_x % 1 === 0 && scale_y % 1 === 0)
            {
                graphic_screen.style["imageRendering"] = "crisp-edges"; // firefox
                graphic_screen.style["imageRendering"] = "pixelated";
                graphic_screen.style["-ms-interpolation-mode"] = "nearest-neighbor";
            }
            else
            {
                graphic_screen.style["imageRendering"] = "";
                graphic_screen.style["-ms-interpolation-mode"] = "";
            }

            // undo fractional css-to-device pixel ratios
            var device_pixel_ratio = window.devicePixelRatio || 1;
            if(device_pixel_ratio % 1 !== 0)
            {
                scale_x /= device_pixel_ratio;
                scale_y /= device_pixel_ratio;
            }
        }

        if(scale_x !== 1)
        {
            elem.style.width = rectangle.width * scale_x + "px";
        }
        if(scale_y !== 1)
        {
            elem.style.height = rectangle.height * scale_y + "px";
        }
    }

    this.update_cursor_scanline = function(start, end, enabled)
    {
        if(start !== cursor_start || end !== cursor_end || enabled !== cursor_enabled)
        {
            if(mode === MODE_TEXT)
            {
                if(enabled)
                {
                    cursor_element.style.display = "inline";
                    cursor_element.style.height = (end - start) + "px";
                    cursor_element.style.marginTop = start + "px";
                }
                else
                {
                    cursor_element.style.display = "none";
                }
            }
            else if(mode === MODE_GRAPHICAL_TEXT)
            {
                if(cursor_row < text_mode_height)
                {
                    changed_rows[cursor_row] = 1;
                }
            }

            cursor_start = start;
            cursor_end = end;
            cursor_enabled = enabled;
        }
    };

    this.update_cursor = function(row, col)
    {
        if(row !== cursor_row || col !== cursor_col)
        {
            if(row < text_mode_height)
            {
                changed_rows[row] = 1;
            }
            if(cursor_row < text_mode_height)
            {
                changed_rows[cursor_row] = 1;
            }

            cursor_row = row;
            cursor_col = col;
        }
    };

    this.text_update_row = function(row)
    {
        var offset = TEXT_BUF_COMPONENT_SIZE * row * text_mode_width,
            row_element,
            color_element,
            fragment;

        var blinking,
            bg_color,
            fg_color,
            text;

        row_element = text_screen.childNodes[row];
        fragment = document.createElement("div");

        for(var i = 0; i < text_mode_width; )
        {
            color_element = document.createElement("span");

            blinking = text_mode_data[offset + FLAGS_INDEX] & FLAG_BLINKING;
            bg_color = text_mode_data[offset + BG_COLOR_INDEX];
            fg_color = text_mode_data[offset + FG_COLOR_INDEX];

            if(blinking)
            {
                color_element.classList.add("blink");
            }

            color_element.style.backgroundColor = number_as_color(bg_color);
            color_element.style.color = number_as_color(fg_color);

            text = "";

            // put characters of the same color in one element
            while(i < text_mode_width &&
                (text_mode_data[offset + FLAGS_INDEX] & FLAG_BLINKING) === blinking &&
                text_mode_data[offset + BG_COLOR_INDEX] === bg_color &&
                text_mode_data[offset + FG_COLOR_INDEX] === fg_color)
            {
                const chr = charmap[text_mode_data[offset + CHARACTER_INDEX]];

                text += chr;
                dbg_assert(chr);

                i++;
                offset += TEXT_BUF_COMPONENT_SIZE;

                if(row === cursor_row)
                {
                    if(i === cursor_col)
                    {
                        // next row will be cursor
                        // create new element
                        break;
                    }
                    else if(i === cursor_col + 1)
                    {
                        // found the cursor
                        cursor_element.style.backgroundColor = color_element.style.color;
                        fragment.appendChild(cursor_element);
                        break;
                    }
                }
            }

            color_element.textContent = text;
            fragment.appendChild(color_element);
        }

        row_element.parentNode.replaceChild(fragment, row_element);
    };

    this.update_buffer = function(layers)
    {
        if(DEBUG_SCREEN_LAYERS)
        {
            // For each visible layer that would've been drawn, draw a
            // rectangle to visualise the layer instead.
            graphic_context.strokeStyle = "#0F0";
            graphic_context.lineWidth = 4;
            for(const layer of layers)
            {
                graphic_context.strokeRect(
                    layer.buffer_x,
                    layer.buffer_y,
                    layer.buffer_width,
                    layer.buffer_height
                );
            }
            graphic_context.lineWidth = 1;
            return;
        }

        for(const layer of layers)
        {
            graphic_context.putImageData(
                layer.image_data,
                layer.screen_x - layer.buffer_x,
                layer.screen_y - layer.buffer_y,
                layer.buffer_x,
                layer.buffer_y,
                layer.buffer_width,
                layer.buffer_height
            );
        }
    };

    // XXX: duplicated in DummyScreenAdapter
    this.get_text_screen = function()
    {
        var screen = [];

        for(var i = 0; i < text_mode_height; i++)
        {
            screen.push(this.get_text_row(i));
        }

        return screen;
    };

    this.get_text_row = function(y)
    {
        const begin = y * text_mode_width * TEXT_BUF_COMPONENT_SIZE + CHARACTER_INDEX;
        const end = begin + text_mode_width * TEXT_BUF_COMPONENT_SIZE;
        let row = "";
        for(let i = begin; i < end; i += TEXT_BUF_COMPONENT_SIZE)
        {
            row += charmap[text_mode_data[i]];
        }
        return row;
    };

    this.init();
}

// WebGPU-powered screen adapter for graphical modes. Text mode stays DOM-based.
export function WebGPUScreenAdapter(options, screen_fill_buffer)
{
    if(!navigator.gpu)
    {
        throw new Error("WebGPU is required but navigator.gpu is unavailable");
    }

    const screen_container = options.container;
    console.assert(screen_container, "options.container must be provided");

    const MODE_TEXT = 0;
    const MODE_GRAPHICAL = 1;

    const CHARACTER_INDEX = 0;
    const FLAGS_INDEX = 1;
    const BG_COLOR_INDEX = 2;
    const FG_COLOR_INDEX = 3;
    const TEXT_BUF_COMPONENT_SIZE = 4;

    const FLAG_BLINKING = 0x01;
    const FLAG_FONT_PAGE_B = 0x02;

    this.FLAG_BLINKING = FLAG_BLINKING;
    this.FLAG_FONT_PAGE_B = FLAG_FONT_PAGE_B;
    this.use_webgpu = true;

    let graphic_screen = screen_container.getElementsByTagName("canvas")[0];
    if(!graphic_screen)
    {
        graphic_screen = document.createElement("canvas");
        screen_container.appendChild(graphic_screen);
    }

    let text_screen = screen_container.getElementsByTagName("div")[0];
    if(!text_screen)
    {
        text_screen = document.createElement("div");
        screen_container.appendChild(text_screen);
    }

    const cursor_element = document.createElement("div");

    // Text-mode state (copied from ScreenAdapter to preserve behaviour)
    let cursor_row;
    let cursor_col;
    let scale_x = options.scale !== undefined ? options.scale : 1;
    let scale_y = options.scale !== undefined ? options.scale : 1;
    let base_scale = 1;
    let changed_rows;
    let mode;
    let text_mode_data;
    let text_mode_width;
    let text_mode_height;
    let font_context;
    let font_image_data;
    let font_is_visible = new Int8Array(8 * 256);
    let font_height;
    let font_width;
    let font_width_9px;
    let font_width_dbl;
    let font_copy_8th_col;
    let font_page_a = 0;
    let font_page_b = 0;
    let blink_visible;
    let tm_last_update = 0;
    let cursor_start;
    let cursor_end;
    let cursor_enabled;
    let text_mode_paused = false;
    let text_timer_id = 0;

    const charmap = get_charmap(options.encoding);

    // WebGPU state
    const canvas_context = graphic_screen.getContext("webgpu");
    if(!canvas_context)
    {
        throw new Error("Failed to acquire WebGPU canvas context");
    }

    // Use rgba8unorm to guarantee storage texture support without requiring optional features.
    const canvas_format = "rgba8unorm";
    const adapterPromise = navigator.gpu.requestAdapter({ powerPreference: "high-performance" });

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

    const init_promise = adapterPromise.then(async adapter =>
    {
        if(!adapter)
        {
            throw new Error("WebGPU adapter unavailable (enable chrome://flags/#enable-unsafe-webgpu or use a compatible browser)");
        }

        device = await adapter.requestDevice();
        queue = device.queue;

        canvas_context.configure({
            device,
            format: canvas_format,
            alphaMode: "opaque",
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_DST,
        });

        const shader_module = device.createShaderModule({
                label: "v86-vga-webgpu",
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

            addr = addr | (((row * virtual_width + col) >> params.addr_shift) + params.start_address);
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
            // Combine pairs like CPU pel width path
            let idx_in_group: u32 = (pixel_addr & 3u) * 2u;
            var pair_val: u32 = 0u;
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

            pair_val = (shift_val << 4u) | (neighbor_shift & 0xFu);
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

        // Modes:
        // 0 - VGA planar (compute index from planes)
        // 1 - VGA 4bpp (palette via dac_map)
        // 2 - VGA 8bpp (palette direct)
        // 3 - SVGA 8bpp (palette direct)
        // 4 - SVGA 15bpp (RGB555)
        // 5 - SVGA 16bpp (RGB565)
        // 6 - SVGA 24bpp (BGR888 packed into u32)
        // 7 - SVGA 32bpp (BGRX8888)
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
    });

    function ensure_buffer(current, size, usage, label)
    {
        if(!current || current.size < size)
        {
            return device.createBuffer({ size: Math.max(size, 1024), usage, label });
        }
        return current;
    }

    function ensure_frame_texture(width, height)
    {
        if(frame_texture && frame_texture_size.width === width && frame_texture_size.height === height)
        {
            return;
        }
        frame_texture_size = { width, height };
        frame_texture = device.createTexture({
            size: { width, height },
            format: canvas_format,
            usage: GPUTextureUsage.COPY_SRC | GPUTextureUsage.STORAGE_BINDING,
        });
    }

    function number_as_color(n)
    {
        n = n.toString(16);
        return "#" + "0".repeat(6 - n.length) + n;
    }

    function elem_set_scale(elem, sx, sy, use_scale)
    {
        if(!sx || !sy)
        {
            return;
        }

        elem.style.width = "";
        elem.style.height = "";

        if(use_scale)
        {
            elem.style.transform = "";
        }

        const rectangle = elem.getBoundingClientRect();

        if(use_scale)
        {
            let scale_str = "";
            scale_str += sx === 1 ? "" : " scaleX(" + sx + ")";
            scale_str += sy === 1 ? "" : " scaleY(" + sy + ")";
            elem.style.transform = scale_str;
        }
        else
        {
            if(sx % 1 === 0 && sy % 1 === 0)
            {
                graphic_screen.style["imageRendering"] = "crisp-edges";
                graphic_screen.style["imageRendering"] = "pixelated";
                graphic_screen.style["-ms-interpolation-mode"] = "nearest-neighbor";
            }
            else
            {
                graphic_screen.style["imageRendering"] = "";
                graphic_screen.style["-ms-interpolation-mode"] = "";
            }

            const device_pixel_ratio = window.devicePixelRatio || 1;
            if(device_pixel_ratio % 1 !== 0)
            {
                sx /= device_pixel_ratio;
                sy /= device_pixel_ratio;
            }
        }

        if(sx !== 1)
        {
            elem.style.width = rectangle.width * sx + "px";
        }
        if(sy !== 1)
        {
            elem.style.height = rectangle.height * sy + "px";
        }
    }

    function update_scale_text()
    {
        elem_set_scale(text_screen, scale_x, scale_y, true);
    }

    function update_scale_graphic()
    {
        elem_set_scale(graphic_screen, scale_x * base_scale, scale_y * base_scale, false);
    }

    this.set_scale = function(sx, sy)
    {
        scale_x = sx;
        scale_y = sy;
        update_scale_text();
        update_scale_graphic();
    };

    this.set_size_graphical = function(width, height, buffer_width, buffer_height)
    {
        graphic_screen.width = width;
        graphic_screen.height = height;

        if(width <= 640 && width * 2 < window.innerWidth * window.devicePixelRatio &&
            height * 2 < window.innerHeight * window.devicePixelRatio)
        {
            base_scale = 2;
        }
        else
        {
            base_scale = 1;
        }

        update_scale_graphic();

        if(device)
        {
            canvas_context.configure({
                device,
                format: canvas_format,
                alphaMode: "opaque",
                usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_DST,
            });
        }
    };

    this.set_size_text = function(cols, rows)
    {
        if(cols === text_mode_width && rows === text_mode_height)
        {
            return;
        }

        changed_rows = new Int8Array(rows);
        text_mode_data = new Int32Array(cols * rows * TEXT_BUF_COMPONENT_SIZE);

        text_mode_width = cols;
        text_mode_height = rows;

        if(mode === MODE_TEXT)
        {
            while(text_screen.childNodes.length > rows)
            {
                text_screen.removeChild(text_screen.firstChild);
            }

            while(text_screen.childNodes.length < rows)
            {
                text_screen.appendChild(document.createElement("div"));
            }

            for(let i = 0; i < rows; i++)
            {
                this.text_update_row(i);
            }

            update_scale_text();
        }
    };

    this.set_mode = function(graphical)
    {
        mode = graphical ? MODE_GRAPHICAL : MODE_TEXT;
        if(mode === MODE_TEXT)
        {
            text_screen.style.display = "block";
            graphic_screen.style.display = "none";
        }
        else
        {
            text_screen.style.display = "none";
            graphic_screen.style.display = "block";
        }
    };

    this.set_font_bitmap = function(height, width_9px, width_dbl, copy_8th_col, vga_bitmap, vga_bitmap_changed)
    {
        const width = width_dbl ? 16 : (width_9px ? 9 : 8);
        const size_changed = font_width !== width || font_height !== height;
        font_height = height;
        font_width = width;
        font_width_9px = width_9px;
        font_width_dbl = width_dbl;
        font_copy_8th_col = copy_8th_col;
        if(size_changed && changed_rows)
        {
            changed_rows.fill(1);
        }
    };

    this.set_font_page = function(page_a, page_b)
    {
        if(font_page_a !== page_a || font_page_b !== page_b)
        {
            font_page_a = page_a;
            font_page_b = page_b;
            if(changed_rows)
            {
                changed_rows.fill(1);
            }
        }
    };

    this.put_char = function(row, col, chr, flags, bg_color, fg_color)
    {
        const p = TEXT_BUF_COMPONENT_SIZE * (row * text_mode_width + col);
        text_mode_data[p + CHARACTER_INDEX] = chr;
        text_mode_data[p + FLAGS_INDEX] = flags;
        text_mode_data[p + BG_COLOR_INDEX] = bg_color;
        text_mode_data[p + FG_COLOR_INDEX] = fg_color;
        changed_rows[row] = 1;
    };

    this.update_cursor_scanline = function(start, end, enabled)
    {
        if(start !== cursor_start || end !== cursor_end || enabled !== cursor_enabled)
        {
            if(mode === MODE_TEXT)
            {
                if(enabled)
                {
                    cursor_element.style.display = "inline";
                    cursor_element.style.height = (end - start) + "px";
                    cursor_element.style.marginTop = start + "px";
                }
                else
                {
                    cursor_element.style.display = "none";
                }
            }

            cursor_start = start;
            cursor_end = end;
            cursor_enabled = enabled;
        }
    };

    this.update_cursor = function(row, col)
    {
        if(row !== cursor_row || col !== cursor_col)
        {
            if(row < text_mode_height)
            {
                changed_rows[row] = 1;
            }
            if(cursor_row < text_mode_height)
            {
                changed_rows[cursor_row] = 1;
            }

            cursor_row = row;
            cursor_col = col;
        }
    };

    this.text_update_row = function(row)
    {
        let offset = TEXT_BUF_COMPONENT_SIZE * row * text_mode_width;
        let row_element,
            color_element,
            fragment;

        let blinking,
            bg_color,
            fg_color,
            text;

        row_element = text_screen.childNodes[row];
        fragment = document.createElement("div");

        for(let i = 0; i < text_mode_width; )
        {
            color_element = document.createElement("span");

            blinking = text_mode_data[offset + FLAGS_INDEX] & FLAG_BLINKING;
            bg_color = text_mode_data[offset + BG_COLOR_INDEX];
            fg_color = text_mode_data[offset + FG_COLOR_INDEX];

            if(blinking)
            {
                color_element.classList.add("blink");
            }

            color_element.style.backgroundColor = number_as_color(bg_color);
            color_element.style.color = number_as_color(fg_color);

            text = "";

            while(i < text_mode_width &&
                (text_mode_data[offset + FLAGS_INDEX] & FLAG_BLINKING) === blinking &&
                text_mode_data[offset + BG_COLOR_INDEX] === bg_color &&
                text_mode_data[offset + FG_COLOR_INDEX] === fg_color)
            {
                const chr = charmap[text_mode_data[offset + CHARACTER_INDEX]];

                text += chr;

                i++;
                offset += TEXT_BUF_COMPONENT_SIZE;

                if(row === cursor_row)
                {
                    if(i === cursor_col)
                    {
                        // next row will be cursor
                        // create new element
                        break;
                    }
                    else if(i === cursor_col + 1)
                    {
                        // found the cursor
                        cursor_element.style.backgroundColor = color_element.style.color;
                        fragment.appendChild(cursor_element);
                        break;
                    }
                }
            }

            color_element.textContent = text;
            fragment.appendChild(color_element);
        }

        row_element.parentNode.replaceChild(fragment, row_element);
    };

    this.update_text = function()
    {
        for(let i = 0; i < text_mode_height; i++)
        {
            if(changed_rows[i])
            {
                this.text_update_row(i);
                changed_rows[i] = 0;
            }
        }
    };

    this.update_graphical = function()
    {
        this.screen_fill_buffer();
    };

    this.update_screen = function()
    {
        if(!text_mode_paused)
        {
            if(mode === MODE_TEXT)
            {
                this.update_text();
            }
            else
            {
                this.update_graphical();
            }
        }
        this.timer();
    };

    this.timer = function()
    {
        text_timer_id = requestAnimationFrame(() => this.update_screen());
    };

    this.pause = function()
    {
        text_mode_paused = true;
        cursor_element.classList.remove("blinking-cursor");
    };

    this.continue = function()
    {
        text_mode_paused = false;
        cursor_element.classList.add("blinking-cursor");
    };

    this.destroy = function()
    {
        if(text_timer_id)
        {
            cancelAnimationFrame(text_timer_id);
            text_timer_id = 0;
        }
    };

    this.clear_screen = function()
    {
        if(!device)
        {
            return;
        }
        const encoder = device.createCommandEncoder();
        const swap_texture = canvas_context.getCurrentTexture();
        const view = swap_texture.createView();
        encoder.beginRenderPass({
            colorAttachments: [{ view, clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: "clear", storeOp: "store" }],
        }).end();
        device.queue.submit([encoder.finish()]);
    };

    this.update_buffer = function(layers)
    {
        // Fallback for callers that still pass CPU ImageData (e.g., SVGA path).
        if(!device)
        {
            return;
        }

        const swap_texture = canvas_context.getCurrentTexture();
        const encoder = device.createCommandEncoder();

        for(const layer of layers)
        {
            const { image_data, screen_x, screen_y, buffer_x, buffer_y, buffer_width, buffer_height } = layer;
            if(!image_data)
            {
                continue;
            }

            const temp_texture = device.createTexture({
                size: { width: image_data.width, height: image_data.height },
                format: canvas_format,
                usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC,
            });

            device.queue.writeTexture(
                { texture: temp_texture },
                image_data.data,
                { bytesPerRow: image_data.width * 4 },
                { width: image_data.width, height: image_data.height },
            );

            const src_origin = { x: buffer_x, y: buffer_y, z: 0 };
            const dst_origin = { x: Math.max(0, screen_x), y: Math.max(0, screen_y), z: 0 };
            const copy_width = Math.min(buffer_width, temp_texture.width - buffer_x, swap_texture.width - dst_origin.x);
            const copy_height = Math.min(buffer_height, temp_texture.height - buffer_y, swap_texture.height - dst_origin.y);

            if(copy_width > 0 && copy_height > 0)
            {
                encoder.copyTextureToTexture(
                    { texture: temp_texture, origin: src_origin },
                    { texture: swap_texture, origin: dst_origin },
                    { width: copy_width, height: copy_height, depthOrArrayLayers: 1 },
                );
            }
        }

        device.queue.submit([encoder.finish()]);
    };

    this.update_buffer_webgpu = function(payload)
    {
        if(!device || !compute_pipeline)
        {
            return;
        }

        const texture_width = payload.texture_width;
        const texture_height = payload.texture_height;

        ensure_frame_texture(texture_width, texture_height);

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

        device.queue.submit([encoder.finish()]);
    };

    this.get_text_screen = function()
    {
        const screen = [];
        for(let i = 0; i < text_mode_height; i++)
        {
            screen.push(this.get_text_row(i));
        }
        return screen;
    };

    this.get_text_row = function(y)
    {
        const begin = y * text_mode_width * TEXT_BUF_COMPONENT_SIZE + CHARACTER_INDEX;
        const end = begin + text_mode_width * TEXT_BUF_COMPONENT_SIZE;
        let row = "";
        for(let i = begin; i < end; i += TEXT_BUF_COMPONENT_SIZE)
        {
            row += charmap[text_mode_data[i]];
        }
        return row;
    };

    this.screen_fill_buffer = screen_fill_buffer;

    this.init = function()
    {
        cursor_element.classList.add("cursor");
        cursor_element.style.position = "absolute";
        cursor_element.style.backgroundColor = "#ccc";
        cursor_element.style.width = "7px";
        cursor_element.style.display = "inline-block";
        cursor_element.classList.add("blinking-cursor");

        this.set_mode(false);
        this.set_size_text(80, 25);
        this.set_scale(scale_x, scale_y);

        this.timer();
    };

    init_promise.then(() => this.init());
}
