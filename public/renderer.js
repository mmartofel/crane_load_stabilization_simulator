// ============================================================
// renderer.js — Three.js 3D scene + top-down Canvas 2D view
// ============================================================

export class CraneRenderer {
  constructor(mountEl) {
    this._mount = mountEl;
    this._width = mountEl.clientWidth || 800;
    this._height = mountEl.clientHeight || 600;

    this._propellerAngle = [0, 0, 0, 0];
    this._trail = [];          // [{x, z}] — load trajectory
    this._MAX_TRAIL = 1800;    // ~30s @ 60fps
    this._yawOffset = 0;       // crane yaw in radians (animated by animateYaw)
    this._yawAnimIv = null;    // interval handle for yaw animation

    this._init();
    this._buildScene();
    this._setupResize();
  }

  _init() {
    const THREE = window.THREE;

    // Renderer
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setSize(this._width, this._height);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this._renderer = this.renderer;
    this.renderer.setClearColor(0x141e2e, 1);
    this._mount.appendChild(this.renderer.domElement);

    // Scene
    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog(0x141e2e, 40, 120);

    // Camera
    this.camera = new THREE.PerspectiveCamera(55, this._width / this._height, 0.1, 500);
    this.camera.position.set(14, 22, 22);
    this.camera.lookAt(0, 14, 0);

    // Controls
    this.controls = new THREE.OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, 14, 0);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 5;
    this.controls.maxDistance = 80;
    this.controls.update();
  }

  _buildScene() {
    const THREE = window.THREE;
    const scene = this.scene;

    // ---- Lights ----
    const ambient = new THREE.AmbientLight(0x3a5070, 2.0);
    scene.add(ambient);

    const dirLight = new THREE.DirectionalLight(0xaadcff, 1.5);
    dirLight.position.set(10, 20, 10);
    dirLight.castShadow = true;
    dirLight.shadow.mapSize.set(1024, 1024);
    dirLight.shadow.camera.near = 0.5;
    dirLight.shadow.camera.far = 100;
    dirLight.shadow.camera.left = -20;
    dirLight.shadow.camera.right = 20;
    dirLight.shadow.camera.top = 20;
    dirLight.shadow.camera.bottom = -5;
    scene.add(dirLight);

    const fillLight = new THREE.PointLight(0x00d4aa, 0.4, 30);
    fillLight.position.set(-5, 8, -5);
    scene.add(fillLight);

    // ---- Grid ----
    const grid = new THREE.GridHelper(40, 20, 0x243040, 0x243040);
    grid.material.opacity = 0.7;
    grid.material.transparent = true;
    scene.add(grid);

    // ---- Ground ----
    const groundGeo = new THREE.PlaneGeometry(40, 40);
    const groundMat = new THREE.MeshLambertMaterial({ color: 0x0f1a24 });
    const ground = new THREE.Mesh(groundGeo, groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);
    this._groundMesh = ground;

    // ---- Crane mast (thin dashed red reference line) ----
    const mastGeo = new THREE.BufferGeometry();
    const mastPoints = new Float32Array([0, 0, 0,  0, 22, 0]);
    mastGeo.setAttribute('position', new THREE.BufferAttribute(mastPoints, 3));
    const mastMat = new THREE.LineDashedMaterial({
      color: 0xff2222,
      linewidth: 1,
      dashSize: 0.5,
      gapSize: 0.35,
    });
    const mastLine = new THREE.Line(mastGeo, mastMat);
    mastLine.computeLineDistances(); // required for LineDashedMaterial
    scene.add(mastLine);
    this._mastMesh = mastLine;

    // ---- Suspension point ----
    const suspGeo = new THREE.SphereGeometry(0.3, 16, 8);
    const suspMat = new THREE.MeshLambertMaterial({ color: 0x00d4aa, emissive: 0x006644 });
    const suspPoint = new THREE.Mesh(suspGeo, suspMat);
    suspPoint.position.set(0, 22, 0);
    scene.add(suspPoint);
    this._suspPoint = suspPoint;

    // ---- Rope (3D cylinder mesh for visible thickness) ----
    const ropeGeo = new THREE.CylinderGeometry(0.06, 0.06, 1, 8);
    ropeGeo.translate(0, 0.5, 0); // shift so Y=0 is the base (not center)
    const ropeMat = new THREE.MeshLambertMaterial({ color: 0x90c0e0 });
    this._ropeMaterial = ropeMat;
    const ropeMesh = new THREE.Mesh(ropeGeo, ropeMat);
    scene.add(ropeMesh);
    this._rope = ropeMesh;

    // ---- Load (cargo ball) ----
    const loadGeo = new THREE.SphereGeometry(0.55, 24, 16);
    const loadMat = new THREE.MeshPhongMaterial({
      color: 0xff6b35,
      specular: 0x4488aa,
      shininess: 60,
      wireframe: false,
    });
    this._load = new THREE.Mesh(loadGeo, loadMat);
    this._loadMesh = this._load;
    this._load.castShadow = true;
    scene.add(this._load);

    // Wireframe overlay on load
    const loadWireGeo = new THREE.SphereGeometry(0.56, 12, 8);
    const loadWireMat = new THREE.MeshBasicMaterial({ color: 0xff8855, wireframe: true, opacity: 0.3, transparent: true });
    const loadWire = new THREE.Mesh(loadWireGeo, loadWireMat);
    this._load.add(loadWire);

    // ---- Propeller frame (cross) ----
    this._propFrame = new THREE.Group();
    scene.add(this._propFrame);

    // Arm N-S
    const armGeo1 = new THREE.BoxGeometry(0.1, 0.1, 2.4);
    const armMat = new THREE.MeshLambertMaterial({ color: 0x4a6a8a });
    const armNS = new THREE.Mesh(armGeo1, armMat);
    this._propFrame.add(armNS);

    // Arm E-W
    const armGeo2 = new THREE.BoxGeometry(2.4, 0.1, 0.1);
    const armEW = new THREE.Mesh(armGeo2, armMat);
    this._propFrame.add(armEW);

    // Center hub
    const hubGeo = new THREE.CylinderGeometry(0.15, 0.15, 0.12, 8);
    const hubMat = new THREE.MeshLambertMaterial({ color: 0x445566 });
    const hub = new THREE.Mesh(hubGeo, hubMat);
    hub.rotation.x = Math.PI / 2;
    this._propFrame.add(hub);

    // ---- Propellers (discs + spin groups) ----
    const propColors = [0x00d4aa, 0x4da6ff, 0x00d4aa, 0x4da6ff];
    const propOffsets = [
      [0, 0, -1.2],   // N
      [1.2, 0, 0],    // E
      [0, 0, 1.2],    // S
      [-1.2, 0, 0],   // W
    ];
    this._propGroups = [];
    this._thrustArrows = [];

    propOffsets.forEach((offset, i) => {
      const spinGroup = new THREE.Group();
      spinGroup.position.set(...offset);

      // Disc
      const discGeo = new THREE.CylinderGeometry(0.42, 0.42, 0.04, 24);
      const discMat = new THREE.MeshPhongMaterial({
        color: propColors[i],
        transparent: true,
        opacity: 0.55,
        emissive: propColors[i],
        emissiveIntensity: 0.1,
        side: THREE.DoubleSide,
      });
      const disc = new THREE.Mesh(discGeo, discMat);
      spinGroup.add(disc);

      // Blade cross (4 blades)
      [0, 1, 2, 3].forEach(k => {
        const bladeGeo = new THREE.BoxGeometry(0.72, 0.06, 0.10);
        const bladeMat = new THREE.MeshLambertMaterial({ color: 0xffffff, opacity: 0.85, transparent: true });
        const blade = new THREE.Mesh(bladeGeo, bladeMat);
        blade.rotation.y = k * Math.PI / 2;
        spinGroup.add(blade);
      });

      this._propFrame.add(spinGroup);
      this._propGroups.push(spinGroup);

      // Thrust arrow (ArrowHelper)
      const dir = new THREE.Vector3(
        i === 1 ? 1 : i === 3 ? -1 : 0,
        0,
        i === 0 ? -1 : i === 2 ? 1 : 0
      );
      const arrow = new THREE.ArrowHelper(dir, new THREE.Vector3(...offset), 0.01, propColors[i], 0.2, 0.15);
      arrow.line.material.opacity = 0.8;
      arrow.line.material.transparent = true;
      this._propFrame.add(arrow);
      this._thrustArrows.push(arrow);
    });

    // ---- Wind arrow ----
    const windDir = new THREE.Vector3(1, 0, 0);
    this._windArrow = new THREE.ArrowHelper(windDir, new THREE.Vector3(-3, 8, 0), 0.1, 0x4da6ff, 0.4, 0.3);
    scene.add(this._windArrow);

    // ---- Trail line ----
    const trailMat = new THREE.LineBasicMaterial({ color: 0x00d4aa, linewidth: 3, opacity: 1.0, transparent: false, vertexColors: false });
    this._trailMaterial = trailMat;
    const trailGeo = new THREE.BufferGeometry();
    const trailBuf = new Float32Array(this._MAX_TRAIL * 3);
    trailGeo.setAttribute('position', new THREE.BufferAttribute(trailBuf, 3));
    trailGeo.setDrawRange(0, 0);
    this._trailLine = new THREE.Line(trailGeo, trailMat);
    scene.add(this._trailLine);

    // ---- Propeller labels M1–M4 (children of propFrame so they follow it) ----
    const propLabelColors = ['#00d4aa', '#4da6ff', '#00d4aa', '#4da6ff'];
    // Position each label slightly above (+0.55 in local Y) the propeller disc
    const propLabelPos = [
      [0, 0.55, -1.2],   // M1 N
      [1.2, 0.55, 0],    // M2 E
      [0, 0.55, 1.2],    // M3 S
      [-1.2, 0.55, 0],   // M4 W
    ];
    this._propLabelSprites = [];
    ['M1', 'M2', 'M3', 'M4'].forEach((name, i) => {
      const pl = this._makeTextSprite(64, 30);
      pl.ctx.fillStyle = 'rgba(0,0,0,0.55)';
      pl.ctx.fillRect(1, 1, 62, 28);
      pl.ctx.font = 'bold 16px monospace';
      pl.ctx.textAlign = 'center';
      pl.ctx.fillStyle = propLabelColors[i];
      pl.ctx.fillText(name, 32, 21);
      pl.texture.needsUpdate = true;
      pl.sprite.position.set(...propLabelPos[i]);
      pl.sprite.scale.set(0.9, 0.42, 1);
      this._propFrame.add(pl.sprite);
      this._propLabelSprites.push(pl.sprite);
    });

    // ---- Load info label (mass + L), positioned in world space and updated each frame ----
    const loadLbl = this._makeTextSprite(160, 46);
    this._loadLabel = loadLbl;
    loadLbl.sprite.scale.set(2.0, 0.58, 1);
    scene.add(loadLbl.sprite);

    // ---- Wind info label (speed, direction, force components), updated each frame ----
    const windLbl = this._makeTextSprite(192, 64);
    this._windLabel = windLbl;
    windLbl.sprite.scale.set(2.6, 0.87, 1);
    scene.add(windLbl.sprite);
  }

  _setupResize() {
    const ro = new ResizeObserver(() => {
      this._width = this._mount.clientWidth;
      this._height = this._mount.clientHeight;
      if (this._width < 10 || this._height < 10) return;
      this.renderer.setSize(this._width, this._height);
      this.camera.aspect = this._width / this._height;
      this.camera.updateProjectionMatrix();
    });
    ro.observe(this._mount);
  }

  // Create a canvas-texture sprite for text labels
  _makeTextSprite(w, h) {
    const THREE = window.THREE;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    const texture = new THREE.CanvasTexture(canvas);
    const mat = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false });
    const sprite = new THREE.Sprite(mat);
    return { sprite, canvas, ctx, texture };
  }

  update(state, pwm, windSpeed, windDir, L) {
    const THREE = window.THREE;
    const { theta_x, theta_y } = state;

    // ---- Load position (rotated by crane yaw offset) ----
    const rawX = Math.sin(theta_x) * L;
    const rawZ = Math.sin(theta_y) * L;
    const cosY = Math.cos(this._yawOffset), sinY = Math.sin(this._yawOffset);
    const px = rawX * cosY - rawZ * sinY;
    const pz = rawX * sinY + rawZ * cosY;
    const py = 22 - Math.cos(Math.sqrt(theta_x*theta_x + theta_y*theta_y)) * L;

    this._load.position.set(px, py, pz);

    // ---- Rope: orient cylinder from suspension point to load ----
    const suspPt = new THREE.Vector3(0, 22, 0);
    const loadPt = new THREE.Vector3(px, py, pz);
    const ropeDir = loadPt.clone().sub(suspPt);
    const ropeDist = ropeDir.length();
    this._rope.position.copy(suspPt);
    this._rope.scale.set(1, ropeDist, 1);
    const ropeQuat = new THREE.Quaternion().setFromUnitVectors(
      new THREE.Vector3(0, 1, 0),
      ropeDir.normalize()
    );
    this._rope.quaternion.copy(ropeQuat);

    // ---- Propeller frame (mid-rope) ----
    const mx = px * 0.5;
    const my = 22 - (22 - py) * 0.5;
    const mz = pz * 0.5;
    this._propFrame.position.set(mx, my, mz);

    // Orient frame along rope direction
    const ropeVec = new THREE.Vector3(px, py - 22, pz).normalize();
    const up = new THREE.Vector3(0, 1, 0);
    const quat = new THREE.Quaternion().setFromUnitVectors(up, ropeVec.negate());
    this._propFrame.quaternion.copy(quat);

    // ---- Spin propellers ----
    pwm.forEach((p, i) => {
      this._propellerAngle[i] += Math.abs(p) * 4.0 + 0.08;
      this._propGroups[i].rotation.y = this._propellerAngle[i];
      // Update disc opacity / emissive
      const disc = this._propGroups[i].children[0];
      disc.material.emissiveIntensity = Math.abs(p) * 0.4;
      disc.material.opacity = 0.4 + Math.abs(p) * 0.4;
    });

    // ---- Thrust arrows ----
    const propOffsets = [
      [0, 0, -1.2],
      [1.2, 0, 0],
      [0, 0, 1.2],
      [-1.2, 0, 0],
    ];
    const propDirs = [
      new THREE.Vector3(0, 0, -1),
      new THREE.Vector3(1, 0, 0),
      new THREE.Vector3(0, 0, 1),
      new THREE.Vector3(-1, 0, 0),
    ];

    pwm.forEach((p, i) => {
      const length = Math.abs(p) * 1.5 + 0.01;
      const dir = propDirs[i].clone();
      if (p < 0) dir.negate();
      this._thrustArrows[i].setDirection(dir.normalize());
      this._thrustArrows[i].setLength(length, Math.min(0.25, length * 0.35), Math.min(0.15, length * 0.25));
      const isActive = Math.abs(p) > 0.02;
      this._thrustArrows[i].setColor(isActive ? 0x00d4aa : 0x334455);
    });

    // ---- Wind arrow ----
    const wRad = (windDir * Math.PI) / 180;
    const wDir = new THREE.Vector3(Math.sin(wRad), 0, Math.cos(wRad));
    this._windArrow.setDirection(wDir.normalize());
    const wLen = Math.max(0.1, windSpeed * 0.3);
    this._windArrow.setLength(wLen, Math.min(0.6, wLen * 0.3), Math.min(0.35, wLen * 0.2));
    this._windArrow.visible = windSpeed > 0.1;

    // ---- Wind info label ----
    if (this._windLabel) {
      const wl = this._windLabel;
      const wCtx = wl.ctx, wW = wl.canvas.width, wH = wl.canvas.height;
      wCtx.clearRect(0, 0, wW, wH);
      wCtx.fillStyle = 'rgba(0,0,0,0.62)';
      wCtx.fillRect(2, 2, wW - 4, wH - 4);
      wCtx.textAlign = 'center';
      const wcx = wW / 2;
      wCtx.font = 'bold 12px monospace';
      wCtx.fillStyle = '#4da6ff';
      wCtx.fillText('WIND', wcx, 16);
      wCtx.font = '11px monospace';
      wCtx.fillStyle = 'rgba(255,255,255,0.9)';
      wCtx.fillText(`${windSpeed.toFixed(1)} m/s   ${windDir.toFixed(0)}\u00b0`, wcx, 31);
      const Fx = +(windSpeed * Math.sin(wRad)).toFixed(1);
      const Fz = +(windSpeed * Math.cos(wRad)).toFixed(1);
      wCtx.fillStyle = 'rgba(255,255,255,0.65)';
      wCtx.font = '10px monospace';
      wCtx.fillText(`Fx:${Fx >= 0 ? '+' : ''}${Fx}  Fz:${Fz >= 0 ? '+' : ''}${Fz}`, wcx, 46);
      wl.texture.needsUpdate = true;
      wl.sprite.position.set(-3, 10.5, 0);
      wl.sprite.visible = windSpeed > 0.1;
    }

    // ---- Trail ----
    this._trail.push({ x: px, y: py, z: pz });
    if (this._trail.length > this._MAX_TRAIL) this._trail.shift();

    const trailPos = this._trailLine.geometry.attributes.position;
    this._trail.forEach((pt, i) => {
      trailPos.setXYZ(i, pt.x, pt.y, pt.z);
    });
    trailPos.needsUpdate = true;
    this._trailLine.geometry.setDrawRange(0, this._trail.length);

    // ---- Load info label ----
    if (this._loadLabel) {
      const ll = this._loadLabel;
      const lCtx = ll.ctx, lW = ll.canvas.width, lH = ll.canvas.height;
      lCtx.clearRect(0, 0, lW, lH);
      lCtx.fillStyle = 'rgba(0,0,0,0.62)';
      lCtx.fillRect(2, 2, lW - 4, lH - 4);
      lCtx.textAlign = 'center';
      const lcx = lW / 2;
      lCtx.font = 'bold 13px monospace';
      lCtx.fillStyle = '#ff9d00';
      lCtx.fillText(`m: ${Math.round(this._loadMass || 50)} kg`, lcx, 17);
      lCtx.fillStyle = '#90c0e0';
      lCtx.fillText(`L: ${L.toFixed(1)} m`, lcx, 34);
      ll.texture.needsUpdate = true;
      ll.sprite.position.set(px + 0.9, py + 0.9, pz);
    }

    // Controls + render
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  setTheme(isDark) {
    const THREE = window.THREE;
    const bg   = isDark ? 0x141e2e : 0xdde8f0;
    const load = isDark ? 0xff6b35 : 0xee4422;
    const rope = isDark ? 0x90c0e0 : 0x334455;
    const gnd  = isDark ? 0x0f1a24 : 0xb0c8d8;

    this._renderer.setClearColor(bg);
    this.scene.background = new THREE.Color(bg);
    this.scene.fog.color.setHex(bg);
    this._loadMesh.material.color.setHex(load);
    this._ropeMaterial.color.setHex(rope);
    // mast is a fixed red reference line — color is not theme-dependent
    this._groundMesh.material.color.setHex(gnd);
  }

  resetTrail() {
    this._trail = [];
    this._trailLine.geometry.setDrawRange(0, 0);
  }

  // Animate crane yaw (slewing) over durationMs milliseconds
  animateYaw(yawDeltaDeg, durationMs) {
    if (this._yawAnimIv) clearInterval(this._yawAnimIv);
    const startYaw  = this._yawOffset;
    const targetYaw = this._yawOffset + (yawDeltaDeg * Math.PI / 180);
    const steps     = Math.max(1, Math.round(durationMs / 50));
    let   step      = 0;
    this._yawAnimIv = setInterval(() => {
      step++;
      const t = step / steps;
      this._yawOffset = startYaw + (targetYaw - startYaw) * t;
      // Visually rotate the mast mesh so the arm appears to slew
      this._mastMesh.rotation.y = this._yawOffset;
      if (step >= steps) {
        clearInterval(this._yawAnimIv);
        this._yawAnimIv = null;
      }
    }, 50);
  }

  // Show/hide/scale load based on mass (m≈2 = empty hook, larger = cargo)
  setLoadVisible(visible, mass = 50) {
    this._loadMass = mass;
    if (!visible || mass <= 3) {
      // Empty hook — tiny grey sphere
      this._load.scale.setScalar(0.3);
      this._loadMesh.material.color.setHex(0x556677);
      this._loadMesh.material.emissive?.setHex(0x000000);
    } else {
      // Scale proportional to cube root of mass ratio vs 50 kg baseline
      const scale = Math.max(0.55, Math.min(1.6, Math.pow(mass / 50, 0.33)));
      this._load.scale.setScalar(scale);
      // Heavier loads are darker / more saturated
      const darkness = Math.min(0.4, (mass - 50) / 400);
      const r = Math.round(0xff * (1 - darkness));
      const g = Math.round(0x6b * (1 - darkness));
      const b = Math.round(0x35 * (1 - darkness * 0.5));
      this._loadMesh.material.color.setRGB(r / 255, g / 255, b / 255);
    }
  }
}
