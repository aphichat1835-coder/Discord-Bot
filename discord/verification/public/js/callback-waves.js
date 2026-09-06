(function () {
  "use strict";

  const canvas = document.getElementById("callback-waves");
  if (!canvas) return;

  // Gracefully verify WebGL support
  const gl = canvas.getContext("webgl", { antialias: false, alpha: false, powerPreference: "low-power" }) ||
             canvas.getContext("experimental-webgl", { antialias: false, alpha: false, powerPreference: "low-power" });
  if (!gl) {
    canvas.style.display = "none";
    return;
  }

  const vertexSource = `
    attribute vec2 a_position;
    void main() {
      gl_Position = vec4(a_position, 0.0, 1.0);
    }
  `;

  const fragmentSource = `
    #ifdef GL_FRAGMENT_PRECISION_HIGH
    precision highp float;
    #else
    precision mediump float;
    #endif

    uniform vec3 u_colors[8];
    uniform vec4 u_scene;
    uniform vec4 u_shape;
    uniform vec4 u_surface;
    uniform vec4 u_finish;
    // uniform vec4 u_transform; // reserved — not active in current shader
    uniform vec4 u_space;
    uniform vec4 u_cursor;

    #define u_resolution u_scene.xy
    #define u_time u_scene.z
    #define u_colorCount u_scene.w
    #define u_scale u_shape.x
    #define u_intensity u_shape.y
    #define u_warp u_shape.w
    #define u_contrast u_surface.y
    #define u_brightness u_surface.z
    #define u_vignette u_finish.y
    #define u_grain u_finish.w
    #define u_mouse u_space.zw
    #define u_cursorPresence u_cursor.x
    #define u_cursorStrength u_cursor.z
    #define u_cursorRadius u_cursor.w

    float hash21(vec2 p) {
      p = fract(p * vec2(234.34, 435.345));
      p += dot(p, p + 34.23);
      return fract(p.x * p.y);
    }

    float noise(vec2 p) {
      vec2 i = floor(p);
      vec2 f = fract(p);
      vec2 u = f * f * (3.0 - 2.0 * f);
      return mix(
        mix(hash21(i), hash21(i + vec2(1.0, 0.0)), u.x),
        mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), u.x),
        u.y
      );
    }

    float fbm(vec2 p) {
      float value = 0.0;
      float amplitude = 0.5;
      for (int i = 0; i < 4; i++) {
        value += amplitude * noise(p);
        p = p * 2.05 + vec2(17.1, 9.2);
        amplitude *= 0.5;
      }
      return value;
    }

    void main() {
      vec2 uv = gl_FragCoord.xy / u_resolution.xy;
      vec2 point = (gl_FragCoord.xy - 0.5 * u_resolution.xy) / min(u_resolution.x, u_resolution.y);
      point *= u_scale;

      // Cursor interaction if active (smooth deflection around cursor)
      if (u_cursorPresence > 0.001) {
        vec2 mNorm = (u_mouse - 0.5 * u_resolution.xy) / min(u_resolution.x, u_resolution.y) * u_scale;
        vec2 diff = point - mNorm;
        float dist = length(diff);
        float radius = max(u_cursorRadius, 0.05);
        float influence = smoothstep(radius, 0.0, dist) * u_cursorPresence * u_cursorStrength;
        point += diff * influence;
      }

      float t = u_time * 0.42;

      // Multi-layer domain warping for silky mesh gradient fluidity
      vec2 warp = vec2(
        fbm(point * 1.4 + vec2(t * 0.12, 2.1)),
        fbm(point * 1.4 + vec2(4.8, t * 0.10))
      ) - 0.5;

      vec2 wp = point + warp * (u_warp * 1.2);

      // 4 dynamic mesh nodes floating smoothly across the canvas
      // Node 1: upper left silver glow
      vec2 n1 = vec2(-0.45 + 0.22 * sin(t * 0.40), 0.32 + 0.15 * cos(t * 0.32));
      // Node 2: upper right mid-tone
      vec2 n2 = vec2(0.48 + 0.20 * cos(t * 0.35 + 1.2), 0.28 + 0.18 * sin(t * 0.44));
      // Node 3: lower center deep charcoal
      vec2 n3 = vec2(-0.15 + 0.25 * cos(t * 0.28 + 2.5), -0.38 + 0.14 * sin(t * 0.36));
      // Node 4: lower right silver accent
      vec2 n4 = vec2(0.42 + 0.22 * sin(t * 0.33 + 3.8), -0.28 + 0.18 * cos(t * 0.26));

      float d1 = length(wp - n1);
      float d2 = length(wp - n2);
      float d3 = length(wp - n3);
      float d4 = length(wp - n4);

      // Soft Gaussian-like radial weights for mesh light fields
      float w1 = smoothstep(1.15, 0.0, d1);
      float w2 = smoothstep(1.20, 0.0, d2);
      float w3 = smoothstep(1.10, 0.0, d3);
      float w4 = smoothstep(1.05, 0.0, d4);

      // Flowing WebGL wave contours
      float wave1 = sin(wp.x * (2.2 + u_intensity * 2.5) + wp.y * 1.6 + t * 0.85);
      float wave2 = cos(wp.x * 1.7 - wp.y * (2.0 + u_intensity * 1.8) - t * 0.65);
      float waveBase = mix(wave1, wave2, 0.5) * 0.5 + 0.5;

      // Wave silky ribbons / crests
      float waveRibbon = sin((wp.y + wave1 * 0.25) * 6.2 + t * 1.1);
      float waveCrest = smoothstep(0.45, 0.98, waveRibbon) * 0.32 * u_intensity;

      // Palette colors: strictly #101010, #3A3A3A, #B0B0B0, #F5F5F5
      vec3 cBase = u_colors[0];       // #101010
      vec3 cDeep = u_colors[1];       // #3A3A3A
      vec3 cSilver = u_colors[2];     // #B0B0B0
      vec3 cHighlight = u_colors[3];  // #F5F5F5

      // Layered composition:
      // Start with charcoal base
      vec3 color = cBase;

      // Layer 1: Ambient mesh gradient spots (deep tones)
      color = mix(color, cDeep, clamp(w3 * 0.75 + w2 * 0.45, 0.0, 1.0));

      // Layer 2: Silver mesh glow field
      float silverField = clamp(w1 * 0.52 + w4 * 0.40, 0.0, 1.0);
      color = mix(color, cSilver, silverField);

      // Layer 3: WebGL waves interacting with the mesh field
      float waveInfluence = waveBase * (silverField * 0.65 + 0.35) * u_intensity;
      color = mix(color, cSilver, clamp(waveInfluence * 0.45, 0.0, 0.6));

      // Layer 4: Flowing silver/white light creases & crests
      float crestGlow = waveCrest * (w1 * 0.7 + w4 * 0.5 + 0.2);
      color = mix(color, cHighlight, clamp(crestGlow, 0.0, 0.55));

      // Soft center vignette so verification card has perfect legibility
      float centerDist = length(uv - vec2(0.5, 0.46));
      color *= smoothstep(1.35, 0.35, centerDist);

      // Contrast adjustments
      color = (color - 0.5) * (u_contrast * 1.5 + 0.25) + 0.5;
      color += (u_brightness - 0.5);

      // Saturation: enforce 100% grayscale (dot with luminance)
      float lum = dot(color, vec3(0.299, 0.587, 0.114));
      color = vec3(lum);

      // Cinematic vignette
      if (u_vignette > 0.0) {
        float vig = length(uv - 0.5);
        color *= clamp(1.0 - vig * u_vignette, 0.0, 1.0);
      }

      // Micro film grain to eliminate 8-bit banding
      if (u_grain > 0.0) {
        float g = hash21(gl_FragCoord.xy + fract(u_time * 0.1));
        color += (g - 0.5) * u_grain;
      }

      gl_FragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
    }
  `;

  function compile(type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      gl.deleteShader(shader);
      return null;
    }
    return shader;
  }

  const vertexShader = compile(gl.VERTEX_SHADER, vertexSource);
  const fragmentShader = compile(gl.FRAGMENT_SHADER, fragmentSource);
  if (!vertexShader || !fragmentShader) {
    canvas.style.display = "none";
    return;
  }

  const program = gl.createProgram();
  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    gl.deleteProgram(program);
    canvas.style.display = "none";
    return;
  }
  gl.useProgram(program);

  // Fullscreen triangle covering clip-space
  const positionBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const positionLocation = gl.getAttribLocation(program, "a_position");
  gl.enableVertexAttribArray(positionLocation);
  gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);

  // Uniform locations
  const uColorsLoc = gl.getUniformLocation(program, "u_colors");
  const uSceneLoc = gl.getUniformLocation(program, "u_scene");
  const uShapeLoc = gl.getUniformLocation(program, "u_shape");
  const uSurfaceLoc = gl.getUniformLocation(program, "u_surface");
  const uFinishLoc = gl.getUniformLocation(program, "u_finish");
  // uTransformLoc omitted — u_transform is not active in current shader
  const uSpaceLoc = gl.getUniformLocation(program, "u_space");
  const uCursorLoc = gl.getUniformLocation(program, "u_cursor");

  // Palette: strictly #101010, #3A3A3A, #B0B0B0, #F5F5F5 (packed into 8 vec3 array)
  const paletteColors = new Float32Array([
    16 / 255, 16 / 255, 16 / 255,       // 0: Base charcoal (#101010)
    58 / 255, 58 / 255, 58 / 255,       // 1: Deep gray/charcoal tone (#3A3A3A)
    176 / 255, 176 / 255, 176 / 255,   // 2: Silver/gray (#B0B0B0)
    245 / 255, 245 / 255, 245 / 255,   // 3: Silver-white highlight (#F5F5F5)
    0, 0, 0,
    0, 0, 0,
    0, 0, 0,
    0, 0, 0
  ]);

  // Parameters
  const speed = 0.35;
  const zoom = 1.05;
  const intensity = 0.60;
  const warp = 0.55;
  const contrast = 0.40;
  const brightness = 0.50;
  const saturation = 0.0;
  const hue = 0.0;
  const vignette = 0.30;
  const grain = 0.02;

  // Accessibility: prefers-reduced-motion
  const motionQuery = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
  let prefersReducedMotion = motionQuery ? motionQuery.matches : false;

  let animId = null;
  let isRunning = false;
  let lastTime = performance.now();
  let accumulatedTime = 0;

  // Cursor tracking with smooth lerp
  let mouseX = 0;
  let mouseY = 0;
  let targetMouseX = 0;
  let targetMouseY = 0;
  let mouseActive = 0.0;
  let targetMouseActive = 0.0;

  function onPointerMove(e) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    targetMouseX = e.clientX * dpr;
    targetMouseY = (window.innerHeight - e.clientY) * dpr;
    targetMouseActive = 1.0;
  }

  function onPointerLeave() {
    targetMouseActive = 0.0;
  }

  window.addEventListener("pointermove", onPointerMove, { passive: true });
  window.addEventListener("pointerleave", onPointerLeave, { passive: true });

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const displayWidth = Math.max(1, Math.floor((canvas.clientWidth || window.innerWidth) * dpr));
    const displayHeight = Math.max(1, Math.floor((canvas.clientHeight || window.innerHeight) * dpr));

    if (canvas.width !== displayWidth || canvas.height !== displayHeight) {
      canvas.width = displayWidth;
      canvas.height = displayHeight;
    }
    gl.viewport(0, 0, canvas.width, canvas.height);
  }

  canvas.addEventListener("webglcontextlost", (e) => {
    e.preventDefault();
    stop();
    canvas.style.display = "none";
  }, false);

  function render(time) {
    if (uColorsLoc) gl.uniform3fv(uColorsLoc, paletteColors);
    if (uSceneLoc) gl.uniform4f(uSceneLoc, canvas.width, canvas.height, time, 4.0);
    if (uShapeLoc) gl.uniform4f(uShapeLoc, zoom, intensity, 0.5, warp);
    // u_surface: x=unused(0), y=contrast, z=brightness, w=saturation(0 — grayscale forced)
    if (uSurfaceLoc) gl.uniform4f(uSurfaceLoc, 0.0, contrast, brightness, saturation);
    if (uFinishLoc) gl.uniform4f(uFinishLoc, hue, vignette, 0.0, grain);
    if (uSpaceLoc) gl.uniform4f(uSpaceLoc, 0.0, 0.0, mouseX, mouseY);
    if (uCursorLoc) gl.uniform4f(uCursorLoc, mouseActive, 1.0, 0.45, 0.65);

    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  function safeRender(time) {
    try {
      render(time);
    } catch {
      stop();
      canvas.style.display = "none";
    }
  }

  function frame(now) {
    if (!isRunning) return;

    const delta = Math.min((now - lastTime) / 1000, 0.1);
    lastTime = now;

    if (!prefersReducedMotion) {
      accumulatedTime += delta * speed;
      mouseX += (targetMouseX - mouseX) * 0.06;
      mouseY += (targetMouseY - mouseY) * 0.06;
      mouseActive += (targetMouseActive - mouseActive) * 0.04;
    }

    safeRender(accumulatedTime);

    if (!prefersReducedMotion) {
      animId = requestAnimationFrame(frame);
    } else {
      isRunning = false;
      animId = null;
    }
  }

  function start() {
    if (isRunning) return;
    if (document.hidden) return;

    isRunning = true;
    lastTime = performance.now();

    if (prefersReducedMotion) {
      safeRender(accumulatedTime);
      isRunning = false;
    } else {
      animId = requestAnimationFrame(frame);
    }
  }

  function stop() {
    if (!isRunning && animId === null) return;
    isRunning = false;
    if (animId !== null) {
      cancelAnimationFrame(animId);
      animId = null;
    }
  }

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      stop();
    } else {
      start();
    }
  });

  if (motionQuery) {
    const handleMotionChange = (e) => {
      prefersReducedMotion = e.matches;
      if (prefersReducedMotion) {
        stop();
        safeRender(accumulatedTime);
      } else if (!document.hidden) {
        start();
      }
    };
    if (motionQuery.addEventListener) {
      motionQuery.addEventListener("change", handleMotionChange);
    } else if (motionQuery.addListener) {
      motionQuery.addListener(handleMotionChange);
    }
  }

  window.addEventListener("resize", () => {
    resize();
    safeRender(accumulatedTime);
  });

  resize();
  start();
})();