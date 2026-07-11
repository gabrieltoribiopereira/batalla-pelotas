/**
 * Batalla de Pelotas — Battle Simulator
 * N characters bounce around an arena WITH GRAVITY.
 * Sword: spinning melee blade, each hit ⇒ damage++
 * Bow: spinning ranged weapon, fires arrows in escalating bursts
 * Shuriken: throws homing stars with cumulative bounces (1 dmg each)
 * Shield: straight bar that bounces enemies away and lengthens per bash
 */

(() => {
    "use strict";

    /* ==================== CANVAS SETUP ==================== */
    const canvas = document.getElementById("arena");
    const ctx = canvas.getContext("2d");

    const DPR = window.devicePixelRatio || 1;
    let W, H; // logical size

    function resizeCanvas() {
        const rect = canvas.getBoundingClientRect();
        W = rect.width;
        H = rect.height;
        canvas.width = W * DPR;
        canvas.height = H * DPR;
        ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    }
    resizeCanvas();
    window.addEventListener("resize", resizeCanvas);

    /* ==================== CONSTANTS ==================== */
    const BALL_RADIUS = 18;
    const MAX_HP = 100;
    const SWORD_LENGTH = 40;
    const SWORD_WIDTH = 6;
    const SWORD_SPIN_SPEED = 1.35;   // rad/s
    const BOW_LENGTH = 36;
    const BOW_SPIN_SPEED = 1;        // rad/s
    const SHURIKEN_SPIN_SPEED = 2.2; // rad/s (launcher arm)
    const ARROW_SPEED = 500;
    const ARROW_LENGTH = 22;
    const HIT_COOLDOWN = 0.1;        // seconds of invulnerability after a hit
    const INITIAL_SPEED = 320;       // px/s for each ball
    const GRAVITY = 200;             // px/s² downward acceleration
    const SPEED_CORRECTION = 1.5;    // per-second rate at which speed eases back to baseSpeed

    /* ---- Fixed-timestep physics ---- */
    const PHYSICS_DT = 1 / 120;      // 120 Hz simulation, independent of display FPS
    const MAX_FRAME = 0.1;           // clamp huge frame gaps (tab switch, etc.)

    /* ---- Burst fire config (bow) ---- */
    const BURST_PAUSE = 2.0;         // seconds between bursts

    /* ---- Shuriken config ---- */
    const SHURIKEN_SPEED = 400;      // px/s, constant (no gravity — it's a spinning blade)
    const SHURIKEN_INTERVAL = 0.45;  // seconds between throws (no limit on live shurikens)
    const SHURIKEN_RADIUS = 9;
    const SHURIKEN_DAMAGE = 1;
    const SHURIKEN_INITIAL_BOUNCES = 3; // wall bounces a player's shurikens start with

    /* ---- Shield config ---- */
    const SHIELD_DAMAGE = 1;          // fixed damage per shield bash
    const SHIELD_SPIN_SPEED = 0.7;    // rev/s
    const SHIELD_OFFSET = BALL_RADIUS + 14; // distance from ball center to the bar
    const SHIELD_BASE_HALFLEN = 16;   // half-length of the bar at size 1
    const SHIELD_GROWTH = 3;          // px of half-length gained per bash
    const SHIELD_THICKNESS = 10;

    const MAX_PLAYERS = 6;
    const MIN_PLAYERS = 2;

    /* ==================== WEAPONS & COLORS ==================== */
    const WEAPON_DEFS = {
        sword:    { icon: "⚔️", label: "Espada",   stat: "Daño",    desc: "Cada golpe aumenta su daño" },
        bow:      { icon: "🏹", label: "Arco",     stat: "Ráfaga",  desc: "Dispara ráfagas cada vez mayores" },
        shuriken: { icon: "✦",  label: "Shuriken", stat: "Rebotes", desc: "Estrellas teledirigidas que acumulan rebotes" },
        shield:   { icon: "🛡️", label: "Escudo",   stat: "Tamaño",  desc: "Barra recta que crece con cada golpe y repele enemigos" },
    };

    const PALETTE = [
        { fill: "#e8a838", stroke: "#c28020", light: "#ffe080" },
        { fill: "#c04848", stroke: "#903030", light: "#e07070" },
        { fill: "#4878c0", stroke: "#305890", light: "#70a0e0" },
        { fill: "#48a868", stroke: "#308048", light: "#70d090" },
        { fill: "#9858c0", stroke: "#703890", light: "#c080e0" },
        { fill: "#48a8a8", stroke: "#308080", light: "#70d0d0" },
    ];

    const COLORS = {
        swordBlade: "#b0b0b0",
        swordEdge: "#e0ddd0",
        bowBody: "#8B5E3C",
        bowString: "#d0c8b0",
        arrow: "#5a3a1a",
        arrowHead: "#888",
        shurikenFill: "#9aa0a8",
        shurikenStroke: "#5a6068",
        shieldBody: "#7a8aa0",
        shieldEdge: "#dfe6f0",
        hpBarBg: "rgba(0,0,0,0.25)",
        hpGreen: "#44cc55",
        hpYellow: "#ddcc22",
        hpRed: "#dd3333",
        hitFlash: "rgba(255,255,255,0.7)",
        damageText: "#ff2222",
    };

    /* ==================== STATE ==================== */
    // Roster lives across restarts; the menu edits it.
    let roster = [
        { weapon: "sword" },
        { weapon: "bow" },
    ];

    let players, arrows, shurikens, particles, damageNumbers;
    let gameOver, started, lastTime;
    let hitStopTimer = 0;
    let timeScale = 1;
    let accumulator = 0;

    /* ---- Game mode & online state ---- */
    let mode = null;        // null | "local" | "online"
    let netRole = null;     // null | "host" | "spectator"
    let ws = null;
    let online = null;      // { selfId, code, hostId, phase, players, roster, rosterBy }
    let lastSnap = null;    // último estado recibido (espectador)
    let lastStateSent = 0;  // throttle de snapshots (anfitrión)
    let myProposal = null;  // null = aleatoria | array de armas propuesta
    let myBet = { target: null, amount: 0 };
    let onlineError = "";

    /* ---- Coins & betting (two local bettors competing) ---- */
    const STARTING_COINS = 100;
    const ROUND_INCOME = 10;     // coins granted to each bettor at the start of a round
    const bettors = [
        { name: "Apostador 1", coins: STARTING_COINS, betTarget: null, betAmount: 0, currentBet: null },
        { name: "Apostador 2", coins: STARTING_COINS, betTarget: null, betAmount: 0, currentBet: null },
    ];

    /* ==================== HIT PARTICLES ==================== */
    class Particle {
        constructor(x, y, color) {
            this.x = x;
            this.y = y;
            const angle = Math.random() * Math.PI * 2;
            const speed = 40 + Math.random() * 100;
            this.vx = Math.cos(angle) * speed;
            this.vy = Math.sin(angle) * speed;
            this.life = 0.4 + Math.random() * 0.3;
            this.maxLife = this.life;
            this.radius = 2 + Math.random() * 3;
            this.color = color;
        }
        update(dt) {
            this.x += this.vx * dt;
            this.y += this.vy * dt;
            this.life -= dt;
        }
        draw() {
            const alpha = Math.max(0, this.life / this.maxLife);
            ctx.globalAlpha = alpha;
            ctx.fillStyle = this.color;
            ctx.beginPath();
            ctx.arc(this.x, this.y, this.radius * alpha, 0, Math.PI * 2);
            ctx.fill();
            ctx.globalAlpha = 1;
        }
    }

    /* ==================== DAMAGE NUMBERS ==================== */
    class DamageNumber {
        constructor(x, y, value) {
            this.x = x;
            this.y = y;
            this.value = value;
            this.life = 0.9;
            this.maxLife = 0.9;
            this.vy = -60;
        }
        update(dt) {
            this.y += this.vy * dt;
            this.vy -= 20 * dt;
            this.life -= dt;
        }
        draw() {
            const alpha = Math.max(0, this.life / this.maxLife);
            const scale = 1 + (1 - alpha) * 0.3;
            ctx.save();
            ctx.globalAlpha = alpha;
            ctx.translate(this.x, this.y);
            ctx.scale(scale, scale);
            ctx.font = "bold 18px 'Outfit', sans-serif";
            ctx.textAlign = "center";
            ctx.fillStyle = COLORS.damageText;
            ctx.strokeStyle = "rgba(0,0,0,0.5)";
            ctx.lineWidth = 3;
            ctx.strokeText(`-${this.value}`, 0, 0);
            ctx.fillText(`-${this.value}`, 0, 0);
            ctx.restore();
        }
    }

    /* ==================== ARROW CLASS ==================== */
    class Arrow {
        constructor(x, y, angle, damage, owner) {
            this.x = x;
            this.y = y;
            this.px = x;
            this.py = y;
            this.vx = Math.cos(angle) * ARROW_SPEED;
            this.vy = Math.sin(angle) * ARROW_SPEED;
            this.angle = angle;
            this.damage = damage;
            this.owner = owner;
            this.alive = true;
            this.bounceCooldown = 0;
        }
        update(dt) {
            this.px = this.x;
            this.py = this.y;

            this.vy += GRAVITY * dt;
            this.x += this.vx * dt;
            this.y += this.vy * dt;
            this.angle = Math.atan2(this.vy, this.vx);

            if (this.bounceCooldown > 0) this.bounceCooldown -= dt;

            // Arrows DON'T bounce — die on wall contact
            if (this.x < 0 || this.x > W || this.y < 0 || this.y > H) {
                this.alive = false;
            }
        }
        draw(alpha) {
            const dx = lerp(this.px, this.x, alpha);
            const dy = lerp(this.py, this.y, alpha);
            ctx.save();
            ctx.translate(dx, dy);
            ctx.rotate(this.angle);

            // Arrow shaft
            ctx.strokeStyle = COLORS.arrow;
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(-ARROW_LENGTH / 2, 0);
            ctx.lineTo(ARROW_LENGTH / 2, 0);
            ctx.stroke();

            // Arrow head
            ctx.fillStyle = COLORS.arrowHead;
            ctx.beginPath();
            ctx.moveTo(ARROW_LENGTH / 2 + 5, 0);
            ctx.lineTo(ARROW_LENGTH / 2 - 3, -3.5);
            ctx.lineTo(ARROW_LENGTH / 2 - 3, 3.5);
            ctx.closePath();
            ctx.fill();

            // Fletching
            ctx.strokeStyle = "#cc4444";
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.moveTo(-ARROW_LENGTH / 2, 0);
            ctx.lineTo(-ARROW_LENGTH / 2 - 4, -3);
            ctx.moveTo(-ARROW_LENGTH / 2, 0);
            ctx.lineTo(-ARROW_LENGTH / 2 - 4, 3);
            ctx.stroke();

            ctx.restore();
        }
    }

    /* ==================== SHURIKEN CLASS ==================== */
    class Shuriken {
        constructor(x, y, angle, owner) {
            this.x = x;
            this.y = y;
            this.px = x;
            this.py = y;
            this.vx = Math.cos(angle) * SHURIKEN_SPEED;
            this.vy = Math.sin(angle) * SHURIKEN_SPEED;
            this.spin = Math.random() * Math.PI * 2;
            this.prevSpin = this.spin;
            this.owner = owner;
            this.alive = true;
            // Wall bounces remaining: inherited from the owner's accumulated counter
            this.bounces = owner ? owner.shurikenBounces : SHURIKEN_INITIAL_BOUNCES;
            this.deflectCooldown = 0; // avoids re-triggering weapon deflections every step
        }

        update(dt) {
            this.px = this.x;
            this.py = this.y;
            this.prevSpin = this.spin;

            this.x += this.vx * dt;
            this.y += this.vy * dt;
            this.spin += 16 * dt;

            if (this.deflectCooldown > 0) this.deflectCooldown -= dt;

            // Wall bounces consume the accumulated counter; with none left it vanishes
            let hitWall = false;
            if (this.x - SHURIKEN_RADIUS < 0)  { this.x = SHURIKEN_RADIUS; this.vx = Math.abs(this.vx); hitWall = true; }
            if (this.x + SHURIKEN_RADIUS > W)  { this.x = W - SHURIKEN_RADIUS; this.vx = -Math.abs(this.vx); hitWall = true; }
            if (this.y - SHURIKEN_RADIUS < 0)  { this.y = SHURIKEN_RADIUS; this.vy = Math.abs(this.vy); hitWall = true; }
            if (this.y + SHURIKEN_RADIUS > H)  { this.y = H - SHURIKEN_RADIUS; this.vy = -Math.abs(this.vy); hitWall = true; }

            if (hitWall) {
                if (this.bounces > 0) {
                    this.bounces--;
                    this.retarget([this.owner]);
                    spawnHitParticles(this.x, this.y, "#cccccc");
                } else {
                    this.alive = false;
                }
            }
        }

        /* Steer toward the nearest enemy; if none, keep the (already reflected) realistic angle */
        retarget(exclude) {
            const target = nearestPlayer(this.x, this.y, exclude);
            if (target) {
                const d = Math.hypot(target.x - this.x, target.y - this.y);
                if (d > 0) {
                    const speed = Math.hypot(this.vx, this.vy);
                    this.vx = ((target.x - this.x) / d) * speed;
                    this.vy = ((target.y - this.y) / d) * speed;
                }
            }
        }

        /* Hitting an enemy WEAPON permanently adds +1 bounce
           to the owner's future shurikens */
        registerHit() {
            if (this.owner) {
                this.owner.shurikenBounces++;
                updateStatValue(this.owner);
            }
        }

        /* Body hit: vanish so shurikens don't pile up on the map */
        onEnemyHit(victim) {
            this.alive = false;
        }

        draw(alpha) {
            const dx = lerp(this.px, this.x, alpha);
            const dy = lerp(this.py, this.y, alpha);
            const spin = lerp(this.prevSpin, this.spin, alpha);
            drawShurikenShape(dx, dy, spin, SHURIKEN_RADIUS);
        }
    }

    /* Four-pointed star, reused by projectile and launcher weapon */
    function drawShurikenShape(x, y, spin, r) {
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(spin);
        ctx.fillStyle = COLORS.shurikenFill;
        ctx.strokeStyle = COLORS.shurikenStroke;
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let i = 0; i < 4; i++) {
            const a = (i / 4) * Math.PI * 2;
            const mid = a + Math.PI / 4;
            ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
            ctx.lineTo(Math.cos(mid) * r * 0.35, Math.sin(mid) * r * 0.35);
        }
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        // Center hole
        ctx.fillStyle = COLORS.shurikenStroke;
        ctx.beginPath();
        ctx.arc(0, 0, r * 0.18, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
    }

    /* ==================== PLAYER CLASS ==================== */
    class Player {
        constructor(type, index, x, y) {
            this.type = type; // "sword" | "bow" | "shuriken"
            this.index = index;
            this.name = `J${index + 1}`;
            this.color = PALETTE[index % PALETTE.length];
            this.x = x;
            this.y = y;
            this.px = x;
            this.py = y;
            this.vx = 0;
            this.vy = 0;
            this.hp = MAX_HP;
            this.damage = 1;
            this.weaponAngle = Math.random() * Math.PI * 2;
            this.prevWeaponAngle = this.weaponAngle;
            this.hitTimer = 0;
            this.flashTimer = 0;
            this.clashTimer = 0;
            this.attackCooldown = 0;
            this.spinDirection = 1;
            this.baseSpeed = INITIAL_SPEED;

            // Burst fire state (bow only)
            this.burstSize = 1;
            this.arrowsFiredInBurst = 0;
            this.burstFireTimer = 0;
            this.burstPauseTimer = 0;
            this.isBursting = true;
            this.bonusArrows = 0;

            // Shuriken state: weapon hits add +1 permanent bounce to new shurikens
            this.throwTimer = SHURIKEN_INTERVAL * (0.5 + Math.random() * 0.5);
            this.shurikenBounces = SHURIKEN_INITIAL_BOUNCES;

            // Shield state: grows every time it bashes an enemy
            this.shieldSize = 1;
        }

        spinSpeed() {
            if (this.type === "sword") return SWORD_SPIN_SPEED;
            if (this.type === "bow") return BOW_SPIN_SPEED;
            if (this.type === "shield") return SHIELD_SPIN_SPEED;
            return SHURIKEN_SPIN_SPEED;
        }

        update(dt) {
            this.px = this.x;
            this.py = this.y;
            this.prevWeaponAngle = this.weaponAngle;

            // Apply gravity (progressive acceleration)
            this.vy += GRAVITY * dt;

            // Move
            this.x += this.vx * dt;
            this.y += this.vy * dt;

            // Bounce off walls (full reflection, no jerky speed snap)
            if (this.x - BALL_RADIUS < 0) { this.x = BALL_RADIUS; this.vx = Math.abs(this.vx); }
            if (this.x + BALL_RADIUS > W) { this.x = W - BALL_RADIUS; this.vx = -Math.abs(this.vx); }
            if (this.y - BALL_RADIUS < 0) { this.y = BALL_RADIUS; this.vy = Math.abs(this.vy); }
            if (this.y + BALL_RADIUS > H) { this.y = H - BALL_RADIUS; this.vy = -Math.abs(this.vy); }

            // Smooth, continuous energy correction: ease speed toward baseSpeed
            // instead of snapping on bounce — keeps motion fluid
            const speed = Math.hypot(this.vx, this.vy);
            if (speed > 1) {
                const corrected = speed + (this.baseSpeed - speed) * Math.min(1, SPEED_CORRECTION * dt);
                const ratio = corrected / speed;
                this.vx *= ratio;
                this.vy *= ratio;
            }

            // Spin weapon
            this.weaponAngle += this.spinDirection * this.spinSpeed() * dt * Math.PI * 2;

            // Cooldowns
            if (this.hitTimer > 0) this.hitTimer -= dt;
            if (this.flashTimer > 0) this.flashTimer -= dt;
            if (this.clashTimer > 0) this.clashTimer -= dt;
            if (this.attackCooldown > 0) this.attackCooldown -= dt;

            if (this.hp > 0) {
                if (this.type === "bow") this.updateBurstFire(dt);
                if (this.type === "shuriken") this.updateShurikenThrow(dt);
            }
        }

        updateBurstFire(dt) {
            if (this.isBursting) {
                this.burstFireTimer -= dt;
                if (this.burstFireTimer <= 0 && this.arrowsFiredInBurst < this.burstSize) {
                    this.shootArrow();
                    this.arrowsFiredInBurst++;

                    if (this.arrowsFiredInBurst >= this.burstSize) {
                        this.isBursting = false;
                        this.burstPauseTimer = BURST_PAUSE;
                    } else {
                        this.burstFireTimer = 0.1 / this.burstSize;
                    }
                }
            } else {
                this.burstPauseTimer -= dt;
                if (this.burstPauseTimer <= 0) {
                    this.burstSize += 1 + this.bonusArrows;
                    this.bonusArrows = 0;
                    this.arrowsFiredInBurst = 0;
                    this.burstFireTimer = 0;
                    this.isBursting = true;
                    updateStatValue(this);
                }
            }
        }

        updateShurikenThrow(dt) {
            this.throwTimer -= dt;
            if (this.throwTimer <= 0) {
                this.throwTimer += SHURIKEN_INTERVAL;
                const tipX = this.x + Math.cos(this.weaponAngle) * (BALL_RADIUS + 12);
                const tipY = this.y + Math.sin(this.weaponAngle) * (BALL_RADIUS + 12);
                shurikens.push(new Shuriken(tipX, tipY, this.weaponAngle, this));
            }
        }

        shootArrow() {
            const tipX = this.x + Math.cos(this.weaponAngle) * (BOW_LENGTH + 8);
            const tipY = this.y + Math.sin(this.weaponAngle) * (BOW_LENGTH + 8);
            arrows.push(new Arrow(tipX, tipY, this.weaponAngle, this.damage, this));
        }

        takeDamage(amount) {
            if (this.hitTimer > 0) return false;
            this.hp = Math.max(0, this.hp - amount);
            this.hitTimer = HIT_COOLDOWN;
            this.flashTimer = 0.12;
            hitStopTimer = 0.12; // brief slow-motion on impact (eased, not a hard freeze)
            return true;
        }

        draw(alpha) {
            const dx = lerp(this.px, this.x, alpha);
            const dy = lerp(this.py, this.y, alpha);
            const angle = lerp(this.prevWeaponAngle, this.weaponAngle, alpha);

            // Shadow
            ctx.fillStyle = "rgba(0,0,0,0.12)";
            ctx.beginPath();
            ctx.ellipse(dx + 3, dy + 4, BALL_RADIUS * 0.9, BALL_RADIUS * 0.5, 0, 0, Math.PI * 2);
            ctx.fill();

            // Glow when hit
            if (this.flashTimer > 0) {
                ctx.fillStyle = COLORS.hitFlash;
                ctx.beginPath();
                ctx.arc(dx, dy, BALL_RADIUS + 6, 0, Math.PI * 2);
                ctx.fill();
            }

            // Ball gradient
            const grad = ctx.createRadialGradient(dx - 5, dy - 5, 2, dx, dy, BALL_RADIUS);
            grad.addColorStop(0, this.color.light);
            grad.addColorStop(1, this.color.fill);

            ctx.fillStyle = grad;
            ctx.strokeStyle = this.color.stroke;
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(dx, dy, BALL_RADIUS, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();

            // Draw weapon
            if (this.type === "sword") this.drawSword(dx, dy, angle);
            else if (this.type === "bow") this.drawBow(dx, dy, angle);
            else if (this.type === "shield") this.drawShield(dx, dy, angle);
            else this.drawShurikenLauncher(dx, dy, angle);

            this.drawHPBar(dx, dy);
        }

        drawSword(cx, cy, angle) {
            ctx.save();
            ctx.translate(cx, cy);
            ctx.rotate(angle);

            // Handle
            ctx.fillStyle = this.color.fill;
            ctx.fillRect(-3, -3, 14, 6);

            // Cross-guard
            ctx.fillStyle = this.color.fill;
            ctx.fillRect(10, -8, 4, 16);

            // Blade
            ctx.fillStyle = COLORS.swordBlade;
            ctx.beginPath();
            ctx.moveTo(14, -SWORD_WIDTH / 2);
            ctx.lineTo(14 + SWORD_LENGTH, -1.5);
            ctx.lineTo(14 + SWORD_LENGTH + 6, 0);
            ctx.lineTo(14 + SWORD_LENGTH, 1.5);
            ctx.lineTo(14, SWORD_WIDTH / 2);
            ctx.closePath();
            ctx.fill();

            // Blade edge highlight
            ctx.strokeStyle = COLORS.swordEdge;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(15, 0);
            ctx.lineTo(14 + SWORD_LENGTH + 4, 0);
            ctx.stroke();

            ctx.restore();
        }

        drawBow(cx, cy, angle) {
            ctx.save();
            ctx.translate(cx, cy);
            ctx.rotate(angle);

            // Bow body (arc)
            ctx.strokeStyle = COLORS.bowBody;
            ctx.lineWidth = 4;
            ctx.lineCap = "round";
            ctx.beginPath();
            ctx.arc(10, 0, BOW_LENGTH, -0.8, 0.8);
            ctx.stroke();

            // String
            ctx.strokeStyle = COLORS.bowString;
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            const topX = 10 + Math.cos(-0.8) * BOW_LENGTH;
            const topY = Math.sin(-0.8) * BOW_LENGTH;
            const botX = 10 + Math.cos(0.8) * BOW_LENGTH;
            const botY = Math.sin(0.8) * BOW_LENGTH;
            ctx.moveTo(topX, topY);
            ctx.lineTo(botX, botY);
            ctx.stroke();

            ctx.restore();
        }

        drawShurikenLauncher(cx, cy, angle) {
            // A shuriken held at the rim, ready to be thrown
            const hx = cx + Math.cos(angle) * (BALL_RADIUS + 10);
            const hy = cy + Math.sin(angle) * (BALL_RADIUS + 10);
            ctx.strokeStyle = this.color.stroke;
            ctx.lineWidth = 3;
            ctx.beginPath();
            ctx.moveTo(cx + Math.cos(angle) * BALL_RADIUS, cy + Math.sin(angle) * BALL_RADIUS);
            ctx.lineTo(hx, hy);
            ctx.stroke();
            drawShurikenShape(hx, hy, angle * 3, SHURIKEN_RADIUS);
        }

        drawShield(cx, cy, angle) {
            const halfLen = shieldHalfLen(this.shieldSize);
            const t = SHIELD_THICKNESS;
            ctx.save();
            ctx.translate(cx, cy);
            ctx.rotate(angle);

            // Arm connecting the ball to the bar
            ctx.strokeStyle = this.color.stroke;
            ctx.lineWidth = 3;
            ctx.lineCap = "round";
            ctx.beginPath();
            ctx.moveTo(BALL_RADIUS - 2, 0);
            ctx.lineTo(SHIELD_OFFSET, 0);
            ctx.stroke();

            // Steel bar
            ctx.fillStyle = COLORS.shieldBody;
            roundRect(ctx, SHIELD_OFFSET - t / 2, -halfLen, t, halfLen * 2, 4);
            ctx.fill();

            // Player-color stripe down the middle
            ctx.fillStyle = this.color.fill;
            roundRect(ctx, SHIELD_OFFSET - t * 0.16, -halfLen + 3, t * 0.32, halfLen * 2 - 6, 2);
            ctx.fill();

            // Front-face highlight
            ctx.strokeStyle = COLORS.shieldEdge;
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.moveTo(SHIELD_OFFSET + t / 2 - 1, -halfLen + 3);
            ctx.lineTo(SHIELD_OFFSET + t / 2 - 1, halfLen - 3);
            ctx.stroke();

            ctx.restore();
        }

        drawHPBar(cx, cy) {
            const barW = 44;
            const barH = 6;
            const barX = cx - barW / 2;
            const barY = cy - BALL_RADIUS - 14;
            const pct = this.hp / MAX_HP;

            // Background
            ctx.fillStyle = COLORS.hpBarBg;
            roundRect(ctx, barX, barY, barW, barH, 3);
            ctx.fill();

            // Fill
            if (pct > 0) {
                let hpColor = COLORS.hpGreen;
                if (pct < 0.3) hpColor = COLORS.hpRed;
                else if (pct < 0.6) hpColor = COLORS.hpYellow;

                ctx.fillStyle = hpColor;
                roundRect(ctx, barX, barY, barW * pct, barH, 3);
                ctx.fill();
            }

            // HP text
            ctx.font = "bold 11px 'Outfit', sans-serif";
            ctx.textAlign = "center";
            ctx.fillStyle = "#fff";
            ctx.strokeStyle = "rgba(0,0,0,0.5)";
            ctx.lineWidth = 2;
            ctx.strokeText(Math.ceil(this.hp), cx, barY - 3);
            ctx.fillText(Math.ceil(this.hp), cx, barY - 3);
        }
    }

    /* ==================== HELPERS ==================== */
    function lerp(a, b, t) {
        return a + (b - a) * t;
    }

    function roundRect(ctx, x, y, w, h, r) {
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.lineTo(x + w - r, y);
        ctx.quadraticCurveTo(x + w, y, x + w, y + r);
        ctx.lineTo(x + w, y + h - r);
        ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
        ctx.lineTo(x + r, y + h);
        ctx.quadraticCurveTo(x, y + h, x, y + h - r);
        ctx.lineTo(x, y + r);
        ctx.quadraticCurveTo(x, y, x + r, y);
        ctx.closePath();
    }

    function dist(a, b) {
        return Math.hypot(a.x - b.x, a.y - b.y);
    }

    function nearestPlayer(x, y, exclude) {
        let best = null;
        let bestD = Infinity;
        for (const p of players) {
            if (p.hp <= 0 || exclude.includes(p)) continue;
            const d = Math.hypot(p.x - x, p.y - y);
            if (d < bestD) {
                bestD = d;
                best = p;
            }
        }
        return best;
    }

    function getSwordTip(p) {
        const totalLen = 14 + SWORD_LENGTH + 6;
        return {
            x: p.x + Math.cos(p.weaponAngle) * totalLen,
            y: p.y + Math.sin(p.weaponAngle) * totalLen,
        };
    }

    function getBladeStart(p) {
        return {
            x: p.x + Math.cos(p.weaponAngle) * 14,
            y: p.y + Math.sin(p.weaponAngle) * 14,
        };
    }

    function pointInCircle(px, py, cx, cy, r) {
        return (px - cx) ** 2 + (py - cy) ** 2 <= r ** 2;
    }

    /* Segment-circle intersection for sword hit detection */
    function segmentCircleIntersect(sx, sy, ex, ey, cx, cy, r) {
        const dx = ex - sx;
        const dy = ey - sy;
        const fx = sx - cx;
        const fy = sy - cy;
        const a = dx * dx + dy * dy;
        const b = 2 * (fx * dx + fy * dy);
        const c = fx * fx + fy * fy - r * r;
        let disc = b * b - 4 * a * c;
        if (disc < 0) return false;
        disc = Math.sqrt(disc);
        const t1 = (-b - disc) / (2 * a);
        const t2 = (-b + disc) / (2 * a);
        return (t1 >= 0 && t1 <= 1) || (t2 >= 0 && t2 <= 1) || (t1 < 0 && t2 > 1);
    }

    function ccw(A, B, C) {
        return (C.y - A.y) * (B.x - A.x) > (B.y - A.y) * (C.x - A.x);
    }

    function segmentsIntersect(A, B, C, D) {
        return ccw(A, C, D) !== ccw(B, C, D) && ccw(A, B, C) !== ccw(A, B, D);
    }

    function pointToSegmentDist(px, py, vx, vy, wx, wy) {
        const l2 = (wx - vx) ** 2 + (wy - vy) ** 2;
        if (l2 === 0) return Math.hypot(px - vx, py - vy);
        let t = ((px - vx) * (wx - vx) + (py - vy) * (wy - vy)) / l2;
        t = Math.max(0, Math.min(1, t));
        return Math.hypot(px - (vx + t * (wx - vx)), py - (vy + t * (wy - vy)));
    }

    function getBowTriangle(bow) {
        const cx = bow.x;
        const cy = bow.y;
        const angle = bow.weaponAngle;
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);

        const topX = 10 + Math.cos(-0.8) * BOW_LENGTH;
        const topY = Math.sin(-0.8) * BOW_LENGTH;
        const botX = 10 + Math.cos(0.8) * BOW_LENGTH;
        const botY = Math.sin(0.8) * BOW_LENGTH;
        const tipX = 10 + BOW_LENGTH;
        const tipY = 0;

        return [
            { x: cx + topX * cos - topY * sin, y: cy + topX * sin + topY * cos },
            { x: cx + botX * cos - botY * sin, y: cy + botX * sin + botY * cos },
            { x: cx + tipX * cos - tipY * sin, y: cy + tipX * sin + tipY * cos }
        ];
    }

    /* Straight shield: a flat bar held in front of the ball,
       perpendicular to the arm, that lengthens with every bash */
    function shieldHalfLen(size) {
        const halfLen = SHIELD_BASE_HALFLEN + (size - 1) * SHIELD_GROWTH;
        // Never longer than the arena so it stays playable
        return Math.min(halfLen, Math.min(W, H) * 0.42);
    }

    /* Segment endpoints (a→b) of the bar in world coordinates */
    function shieldGeom(p) {
        const halfLen = shieldHalfLen(p.shieldSize);
        const cos = Math.cos(p.weaponAngle);
        const sin = Math.sin(p.weaponAngle);
        const cx = p.x + cos * SHIELD_OFFSET;
        const cy = p.y + sin * SHIELD_OFFSET;
        return {
            halfLen,
            thickness: SHIELD_THICKNESS,
            ax: cx - sin * halfLen,
            ay: cy + cos * halfLen,
            bx: cx + sin * halfLen,
            by: cy - cos * halfLen,
        };
    }

    /* Closest point on the bar to (x, y) plus the unit normal pointing toward it */
    function shieldContact(g, x, y) {
        const dxSeg = g.bx - g.ax;
        const dySeg = g.by - g.ay;
        const l2 = dxSeg * dxSeg + dySeg * dySeg;
        let t = l2 === 0 ? 0 : ((x - g.ax) * dxSeg + (y - g.ay) * dySeg) / l2;
        t = Math.max(0, Math.min(1, t));
        const px = g.ax + t * dxSeg;
        const py = g.ay + t * dySeg;
        const dx = x - px;
        const dy = y - py;
        const d = Math.hypot(dx, dy);
        if (d === 0) return null;
        return { nx: dx / d, ny: dy / d, dist: d, px, py };
    }

    function pointInShield(p, x, y, margin) {
        const g = shieldGeom(p);
        return pointToSegmentDist(x, y, g.ax, g.ay, g.bx, g.by) <= g.thickness / 2 + margin;
    }

    /* ==================== INIT ==================== */
    function init() {
        resizeCanvas();

        // Spawn players evenly on a circle around the center
        const cx = W / 2;
        const cy = H / 2;
        const n = roster.length;
        const spawnR = n <= 2 ? 30 : Math.min(W, H) * 0.25;

        players = roster.map((entry, i) => {
            const a = (i / n) * Math.PI * 2 - Math.PI / 2;
            const px = cx + Math.cos(a) * spawnR + (Math.random() - 0.5) * 10;
            const py = cy + Math.sin(a) * spawnR + (Math.random() - 0.5) * 10;
            return new Player(entry.weapon, i, px, py);
        });

        arrows = [];
        shurikens = [];
        particles = [];
        damageNumbers = [];
        gameOver = false;
        started = false;
        hitStopTimer = 0;
        timeScale = 1;
        accumulator = 0;
        lastTime = performance.now();

        buildHeader();
        buildStatsUI();
        document.getElementById("winner-overlay").classList.add("hidden");
        // El menú local solo se muestra en modo local
        document.getElementById("setup-overlay").classList.toggle("hidden", mode !== "local");
        const again = document.getElementById("btn-play-again");
        again.disabled = false;
        again.textContent = "Jugar otra vez";
        renderMenu();
    }

    function startGame() {
        if (started) return;
        if (roster.length < MIN_PLAYERS) return;
        started = true;
        lastTime = performance.now();

        // Round income for both bettors, then lock in their bets
        // (payout = bet × fighter count)
        for (const b of bettors) {
            b.coins += ROUND_INCOME;
            if (b.betTarget !== null && b.betAmount > 0) {
                const amount = Math.min(b.betAmount, b.coins);
                b.coins -= amount;
                b.currentBet = { index: b.betTarget, amount, multiplier: roster.length };
            } else {
                b.currentBet = null;
            }
        }
        renderBetUI();

        for (const p of players) {
            const a = Math.random() * Math.PI * 2;
            p.vx = Math.cos(a) * INITIAL_SPEED;
            p.vy = Math.sin(a) * INITIAL_SPEED;
            p.baseSpeed = INITIAL_SPEED;
        }

        document.getElementById("setup-overlay").classList.add("hidden");
    }

    /* ==================== SETUP MENU ==================== */
    const playerListEl = document.getElementById("player-list");
    const btnAddPlayer = document.getElementById("btn-add-player");
    const btnStart = document.getElementById("btn-start");

    function renderMenu() {
        playerListEl.innerHTML = "";

        roster.forEach((entry, i) => {
            const row = document.createElement("div");
            row.className = "player-row";

            const dot = document.createElement("span");
            dot.className = "player-dot";
            dot.style.background = PALETTE[i % PALETTE.length].fill;
            row.appendChild(dot);

            const name = document.createElement("span");
            name.className = "player-name";
            name.textContent = `Jugador ${i + 1}`;
            row.appendChild(name);

            const weapons = document.createElement("div");
            weapons.className = "weapon-picker";
            for (const [key, def] of Object.entries(WEAPON_DEFS)) {
                const btn = document.createElement("button");
                btn.className = "weapon-btn" + (entry.weapon === key ? " selected" : "");
                btn.textContent = def.icon;
                btn.title = `${def.label} — ${def.desc}`;
                btn.addEventListener("click", () => {
                    entry.weapon = key;
                    rebuildPreview();
                });
                weapons.appendChild(btn);
            }
            row.appendChild(weapons);

            const weaponLabel = document.createElement("span");
            weaponLabel.className = "weapon-label";
            weaponLabel.textContent = WEAPON_DEFS[entry.weapon].label;
            row.appendChild(weaponLabel);

            const remove = document.createElement("button");
            remove.className = "remove-btn";
            remove.textContent = "✕";
            remove.title = "Eliminar jugador";
            remove.disabled = roster.length <= MIN_PLAYERS;
            remove.addEventListener("click", () => {
                roster.splice(i, 1);
                rebuildPreview();
            });
            row.appendChild(remove);

            playerListEl.appendChild(row);
        });

        btnAddPlayer.disabled = roster.length >= MAX_PLAYERS;
        btnStart.disabled = roster.length < MIN_PLAYERS;

        renderBetUI();
    }

    /* ==================== BETTING UI (two local bettors) ==================== */
    function renderBetUI() {
        const container = document.getElementById("bettors");
        container.innerHTML = "";

        bettors.forEach((b) => {
            if (b.betTarget !== null && b.betTarget >= roster.length) b.betTarget = null;
            b.betAmount = Math.max(0, Math.min(b.betAmount, b.coins));

            const panel = document.createElement("div");
            panel.className = "bettor-panel";

            const head = document.createElement("div");
            head.className = "bettor-head";
            const nameEl = document.createElement("span");
            nameEl.className = "bettor-name";
            nameEl.textContent = b.name;
            head.appendChild(nameEl);
            const coinsEl = document.createElement("span");
            coinsEl.className = "bettor-coins";
            coinsEl.textContent = `🪙 ${b.coins}`;
            head.appendChild(coinsEl);
            panel.appendChild(head);

            const fightersEl = document.createElement("div");
            fightersEl.className = "bet-fighters";

            const noneBtn = document.createElement("button");
            noneBtn.className = "bet-chip" + (b.betTarget === null ? " selected" : "");
            noneBtn.textContent = "Sin apuesta";
            noneBtn.addEventListener("click", () => {
                b.betTarget = null;
                renderBetUI();
            });
            fightersEl.appendChild(noneBtn);

            roster.forEach((entry, i) => {
                const chip = document.createElement("button");
                chip.className = "bet-chip" + (b.betTarget === i ? " selected" : "");
                chip.style.borderColor = PALETTE[i % PALETTE.length].fill;
                chip.textContent = `${WEAPON_DEFS[entry.weapon].icon} J${i + 1}`;
                chip.addEventListener("click", () => {
                    b.betTarget = i;
                    renderBetUI();
                });
                fightersEl.appendChild(chip);
            });
            panel.appendChild(fightersEl);

            const row = document.createElement("div");
            row.className = "bet-amount-row";
            const addAdjButton = (delta) => {
                const btn = document.createElement("button");
                btn.className = "bet-adj";
                btn.textContent = delta > 0 ? `+${delta}` : `−${-delta}`;
                btn.addEventListener("click", () => {
                    b.betAmount = Math.max(0, Math.min(b.betAmount + delta, b.coins));
                    renderBetUI();
                });
                row.appendChild(btn);
            };
            addAdjButton(-10);
            addAdjButton(-1);
            const amountEl = document.createElement("span");
            amountEl.className = "bet-amount";
            amountEl.textContent = b.betAmount;
            row.appendChild(amountEl);
            addAdjButton(1);
            addAdjButton(10);
            panel.appendChild(row);

            const mult = document.createElement("div");
            mult.className = "bet-multiplier";
            mult.textContent = b.betTarget !== null && b.betAmount > 0
                ? `Premio: ${b.betAmount * roster.length} (x${roster.length})`
                : "";
            panel.appendChild(mult);

            container.appendChild(panel);
        });
    }

    /* Re-create the (paused) players behind the menu so changes are visible immediately */
    function rebuildPreview() {
        init();
    }

    btnAddPlayer.addEventListener("click", () => {
        if (roster.length >= MAX_PLAYERS) return;
        roster.push({ weapon: "shuriken" });
        rebuildPreview();
    });

    document.getElementById("btn-random").addEventListener("click", () => {
        const weaponKeys = Object.keys(WEAPON_DEFS);
        const n = MIN_PLAYERS + Math.floor(Math.random() * (MAX_PLAYERS - MIN_PLAYERS + 1));
        roster = Array.from({ length: n }, () => ({
            weapon: weaponKeys[Math.floor(Math.random() * weaponKeys.length)],
        }));
        rebuildPreview();
    });

    btnStart.addEventListener("click", startGame);

    /* ==================== DYNAMIC UI (header & stats) ==================== */
    function buildHeader() {
        const el = document.getElementById("header-players");
        el.innerHTML = "";
        roster.forEach((entry, i) => {
            if (i > 0) {
                const vs = document.createElement("span");
                vs.className = "vs-sep";
                vs.textContent = "VS";
                el.appendChild(vs);
            }
            const chip = document.createElement("span");
            chip.className = "header-chip";
            chip.style.color = PALETTE[i % PALETTE.length].fill;
            chip.textContent = `${WEAPON_DEFS[entry.weapon].icon} J${i + 1}`;
            el.appendChild(chip);
        });
    }

    function buildStatsUI() {
        const el = document.getElementById("stats-row");
        el.innerHTML = "";
        players.forEach((p) => {
            const box = document.createElement("div");
            box.className = "player-stats";
            box.id = `stats-p${p.index}`;

            box.style.borderColor = p.color.fill;

            const label = document.createElement("div");
            label.className = "stat-label";
            label.textContent = `${WEAPON_DEFS[p.type].icon} J${p.index + 1} · ${WEAPON_DEFS[p.type].stat}`;
            box.appendChild(label);

            const value = document.createElement("div");
            value.className = "stat-value";
            value.id = `stat-value-p${p.index}`;
            value.style.color = p.color.fill;
            value.textContent = statValueOf(p);
            box.appendChild(value);

            el.appendChild(box);
        });
    }

    function statValueOf(p) {
        if (p.type === "sword") return p.damage;
        if (p.type === "bow") return p.burstSize;
        if (p.type === "shield") return p.shieldSize;
        return p.shurikenBounces;
    }

    function updateStatValue(p) {
        const el = document.getElementById(`stat-value-p${p.index}`);
        if (!el) return;
        el.textContent = statValueOf(p);
        el.classList.remove("bump");
        void el.offsetWidth; // reflow
        el.classList.add("bump");
    }

    function markDead(p) {
        const box = document.getElementById(`stats-p${p.index}`);
        if (box) box.classList.add("dead");
    }

    /* ==================== COLLISION DETECTION ==================== */
    function checkCollisions() {
        // --- Ball-ball elastic collisions (all pairs) ---
        for (let i = 0; i < players.length; i++) {
            for (let j = i + 1; j < players.length; j++) {
                const a = players[i];
                const b = players[j];
                const d = dist(a, b);
                if (d < BALL_RADIUS * 2 && d > 0) {
                    const nx = (b.x - a.x) / d;
                    const ny = (b.y - a.y) / d;

                    const dvx = a.vx - b.vx;
                    const dvy = a.vy - b.vy;
                    const dvDotN = dvx * nx + dvy * ny;

                    if (dvDotN > 0) {
                        // Equal mass elastic collision
                        a.vx -= dvDotN * nx;
                        a.vy -= dvDotN * ny;
                        b.vx += dvDotN * nx;
                        b.vy += dvDotN * ny;
                    }

                    const overlap = BALL_RADIUS * 2 - d;
                    a.x -= nx * overlap / 2;
                    a.y -= ny * overlap / 2;
                    b.x += nx * overlap / 2;
                    b.y += ny * overlap / 2;
                }
            }
        }

        // --- Shield bash: enemies bounce off the flat bar, take fixed damage, shield grows ---
        for (const s of players) {
            if (s.type !== "shield" || s.hp <= 0) continue;
            const g = shieldGeom(s);
            for (const o of players) {
                if (o === s || o.hp <= 0) continue;
                const c = shieldContact(g, o.x, o.y);
                if (!c) continue;
                const minDist = g.thickness / 2 + BALL_RADIUS;
                if (c.dist >= minDist) continue;

                // Push the enemy onto the shield face and reflect them off it
                o.x = c.px + c.nx * minDist;
                o.y = c.py + c.ny * minDist;
                const vDot = o.vx * c.nx + o.vy * c.ny;
                if (vDot < 0) {
                    o.vx -= 2 * vDot * c.nx;
                    o.vy -= 2 * vDot * c.ny;
                }

                if (s.attackCooldown <= 0 && o.takeDamage(SHIELD_DAMAGE)) {
                    s.shieldSize++;
                    updateStatValue(s);
                    spawnHitParticles(o.x, o.y, o.color.fill);
                    damageNumbers.push(new DamageNumber(o.x, o.y - BALL_RADIUS - 20, SHIELD_DAMAGE));
                    s.attackCooldown = 0.3;
                }
            }
        }

        // --- Sword melee: clash with other weapons or hit bodies ---
        for (const s of players) {
            if (s.type !== "sword" || s.hp <= 0) continue;
            const tip = getSwordTip(s);
            const bladeStart = getBladeStart(s);

            for (const o of players) {
                if (o === s || o.hp <= 0) continue;

                // 1. Weapon clash check
                let clashed = false;
                if (o.type === "bow") {
                    const tri = getBowTriangle(o);
                    clashed = segmentsIntersect(bladeStart, tip, tri[0], tri[1]) ||
                              segmentsIntersect(bladeStart, tip, tri[1], tri[2]) ||
                              segmentsIntersect(bladeStart, tip, tri[2], tri[0]);
                } else if (o.type === "sword") {
                    clashed = segmentsIntersect(bladeStart, tip, getBladeStart(o), getSwordTip(o));
                } else if (o.type === "shield") {
                    const midX = (bladeStart.x + tip.x) / 2;
                    const midY = (bladeStart.y + tip.y) / 2;
                    clashed = pointInShield(o, tip.x, tip.y, 2) || pointInShield(o, midX, midY, 2);
                }

                if (clashed) {
                    if (Math.random() < 0.3) {
                        spawnHitParticles((tip.x + o.x) / 2, (tip.y + o.y) / 2, "#ffffff");
                    }
                    if (s.clashTimer <= 0) {
                        s.spinDirection *= -1;
                        s.clashTimer = 0.2;
                    }
                    if (o.clashTimer <= 0) {
                        o.spinDirection *= -1;
                        o.clashTimer = 0.2;
                    }
                } else if (segmentCircleIntersect(bladeStart.x, bladeStart.y, tip.x, tip.y, o.x, o.y, BALL_RADIUS)) {
                    if (s.attackCooldown <= 0 && o.takeDamage(s.damage)) {
                        s.damage++;
                        updateStatValue(s);
                        spawnHitParticles(o.x, o.y, o.color.fill);
                        damageNumbers.push(new DamageNumber(o.x, o.y - BALL_RADIUS - 20, s.damage - 1));
                        s.attackCooldown = 0.5;
                    }
                }
            }
        }

        // --- Arrows ---
        for (const a of arrows) {
            if (!a.alive) continue;

            // Deflected by any other player's sword blade
            let deflected = false;
            for (const s of players) {
                if (s.type !== "sword" || s === a.owner || s.hp <= 0) continue;
                const tip = getSwordTip(s);
                const bladeStart = getBladeStart(s);
                if (a.bounceCooldown <= 0 &&
                    pointToSegmentDist(a.x, a.y, bladeStart.x, bladeStart.y, tip.x, tip.y) < 10) {
                    const dx = tip.x - bladeStart.x;
                    const dy = tip.y - bladeStart.y;
                    const len = Math.hypot(dx, dy);
                    if (len > 0) {
                        const nx = -dy / len;
                        const ny = dx / len;
                        const dot = a.vx * nx + a.vy * ny;
                        a.vx = (a.vx - 2 * dot * nx) * 1.3;
                        a.vy = (a.vy - 2 * dot * ny) * 1.3;
                        a.angle = Math.atan2(a.vy, a.vx);
                        a.bounceCooldown = 0.2;
                    }
                    spawnHitParticles(a.x, a.y, "#ffffff");
                    deflected = true;
                    break;
                }
            }

            // Blocked by any other player's shield: bounces off the arc
            if (!deflected) {
                for (const s of players) {
                    if (s.type !== "shield" || s === a.owner || s.hp <= 0) continue;
                    if (a.bounceCooldown <= 0 && pointInShield(s, a.x, a.y, 3)) {
                        const c = shieldContact(shieldGeom(s), a.x, a.y);
                        if (c) {
                            const dot = a.vx * c.nx + a.vy * c.ny;
                            a.vx -= 2 * dot * c.nx;
                            a.vy -= 2 * dot * c.ny;
                            a.angle = Math.atan2(a.vy, a.vx);
                            a.bounceCooldown = 0.2;
                        }
                        spawnHitParticles(a.x, a.y, "#ffffff");
                        deflected = true;
                        break;
                    }
                }
            }
            if (deflected) continue;

            // Hit player bodies (deflected arrows can hit their owner too)
            for (const p of players) {
                if (p.hp <= 0) continue;
                if (p === a.owner && a.bounceCooldown <= 0) continue;
                if (pointInCircle(a.x, a.y, p.x, p.y, BALL_RADIUS + 3)) {
                    if (p.takeDamage(a.damage)) {
                        spawnHitParticles(p.x, p.y, p.color.fill);
                        damageNumbers.push(new DamageNumber(p.x, p.y - BALL_RADIUS - 20, a.damage));
                        if (a.owner && a.owner.type === "bow" && p !== a.owner) {
                            a.owner.bonusArrows++;
                        }
                    }
                    a.alive = false;
                    break;
                }
            }
        }

        // --- Shurikens hit enemies ---
        for (const s of shurikens) {
            if (!s.alive) continue;

            // Hitting an enemy WEAPON also counts as a hit: gains chain bounces
            // and the shuriken deflects realistically off the surface
            let deflected = false;
            if (s.deflectCooldown <= 0) {
                for (const p of players) {
                    if (p === s.owner || p.hp <= 0) continue;
                    let normal = null;

                    if (p.type === "sword") {
                        const bladeStart = getBladeStart(p);
                        const tip = getSwordTip(p);
                        if (pointToSegmentDist(s.x, s.y, bladeStart.x, bladeStart.y, tip.x, tip.y) < SHURIKEN_RADIUS + 3) {
                            const dx = tip.x - bladeStart.x;
                            const dy = tip.y - bladeStart.y;
                            const len = Math.hypot(dx, dy);
                            if (len > 0) normal = { x: -dy / len, y: dx / len };
                        }
                    } else if (p.type === "bow") {
                        const tri = getBowTriangle(p);
                        for (let e = 0; e < 3; e++) {
                            const A = tri[e];
                            const B = tri[(e + 1) % 3];
                            if (pointToSegmentDist(s.x, s.y, A.x, A.y, B.x, B.y) < SHURIKEN_RADIUS + 2) {
                                const dx = B.x - A.x;
                                const dy = B.y - A.y;
                                const len = Math.hypot(dx, dy);
                                if (len > 0) normal = { x: -dy / len, y: dx / len };
                                break;
                            }
                        }
                    } else if (p.type === "shield") {
                        if (pointInShield(p, s.x, s.y, SHURIKEN_RADIUS)) {
                            const c = shieldContact(shieldGeom(p), s.x, s.y);
                            if (c) normal = { x: c.nx, y: c.ny };
                        }
                    }

                    if (normal) {
                        const dot = s.vx * normal.x + s.vy * normal.y;
                        s.vx -= 2 * dot * normal.x;
                        s.vy -= 2 * dot * normal.y;
                        s.registerHit();
                        s.bounces++; // the deflected shuriken keeps flying with one extra bounce
                        s.deflectCooldown = 0.25;
                        spawnHitParticles(s.x, s.y, "#ffffff");
                        deflected = true;
                        break;
                    }
                }
            }
            if (deflected) continue;

            for (const p of players) {
                if (p.hp <= 0 || p === s.owner) continue;
                if (pointInCircle(s.x, s.y, p.x, p.y, BALL_RADIUS + SHURIKEN_RADIUS - 4)) {
                    if (p.takeDamage(SHURIKEN_DAMAGE)) {
                        spawnHitParticles(s.x, s.y, p.color.fill);
                        damageNumbers.push(new DamageNumber(p.x, p.y - BALL_RADIUS - 20, SHURIKEN_DAMAGE));
                    }
                    s.onEnemyHit(p);
                    break;
                }
            }
        }
    }

    function spawnHitParticles(x, y, color) {
        for (let i = 0; i < 10; i++) {
            particles.push(new Particle(x, y, color));
        }
        for (let i = 0; i < 5; i++) {
            particles.push(new Particle(x, y, "#fff"));
        }
    }

    /* ==================== DEATHS & WIN CHECK ==================== */
    function handleDeaths() {
        for (const p of players) {
            if (p.hp <= 0 && !p.deathHandled) {
                p.deathHandled = true;
                spawnHitParticles(p.x, p.y, p.color.fill);
                spawnHitParticles(p.x, p.y, p.color.light);
                markDead(p);
            }
        }
        players = players.filter(p => p.hp > 0);
    }

    function checkWin() {
        if (players.length > 1) return;
        gameOver = true;
        if (mode === "online") {
            // El servidor liquida las apuestas; el overlay se muestra al recibir "result"
            if (netRole === "host") {
                const winner = players.length === 1 ? players[0] : null;
                wsSend({ t: "result", winner: winner ? winner.index : null });
            }
            return;
        }
        const overlay = document.getElementById("winner-overlay");
        const winText = document.getElementById("winner-text");
        let winner = null;
        if (players.length === 1) {
            winner = players[0];
            winText.textContent = `${WEAPON_DEFS[winner.type].icon} ¡${winner.name} (${WEAPON_DEFS[winner.type].label}) gana!`;
            winText.style.color = winner.color.fill;
        } else {
            winText.textContent = "¡Empate!";
            winText.style.color = "#f0ece4";
        }
        settleBet(winner);
        overlay.classList.remove("hidden");
    }

    function settleBet(winner) {
        const resultEl = document.getElementById("bet-result");
        resultEl.innerHTML = "";
        let anyBet = false;

        for (const b of bettors) {
            if (!b.currentBet) continue;
            anyBet = true;
            const { index, amount, multiplier } = b.currentBet;
            const line = document.createElement("div");
            line.className = "bet-result-line";
            if (winner && winner.index === index) {
                const payout = amount * multiplier;
                b.coins += payout;
                line.textContent = `🪙 ${b.name}: ¡apuesta ganada! +${payout} (x${multiplier})`;
                line.style.color = "#44cc55";
            } else if (!winner) {
                b.coins += amount; // draw: bet refunded
                line.textContent = `🪙 ${b.name}: empate, apuesta devuelta (+${amount})`;
                line.style.color = "#f0ece4";
            } else {
                line.textContent = `🪙 ${b.name}: apuesta perdida −${amount}`;
                line.style.color = "#ff4455";
            }
            b.currentBet = null;
            resultEl.appendChild(line);
        }

        // Local rivalry standings
        if (anyBet || bettors[0].coins !== bettors[1].coins) {
            const standing = document.createElement("div");
            standing.className = "bet-standing";
            const [b1, b2] = bettors;
            if (b1.coins === b2.coins) {
                standing.textContent = `🏆 Empate a 🪙 ${b1.coins}`;
            } else {
                const leader = b1.coins > b2.coins ? b1 : b2;
                standing.textContent = `🏆 ${leader.name} lidera: ${b1.coins} − ${b2.coins}`;
            }
            resultEl.appendChild(standing);
        }
    }

    /* ==================== DRAW ARENA ==================== */
    function drawArena() {
        ctx.fillStyle = "#f5f0e8";
        ctx.fillRect(0, 0, W, H);

        // Subtle grid lines
        ctx.strokeStyle = "rgba(0,0,0,0.05)";
        ctx.lineWidth = 1;
        const gridSize = 40;
        for (let x = gridSize; x < W; x += gridSize) {
            ctx.beginPath();
            ctx.moveTo(x, 0);
            ctx.lineTo(x, H);
            ctx.stroke();
        }
        for (let y = gridSize; y < H; y += gridSize) {
            ctx.beginPath();
            ctx.moveTo(0, y);
            ctx.lineTo(W, y);
            ctx.stroke();
        }

        // Border highlight
        ctx.strokeStyle = "rgba(0,0,0,0.15)";
        ctx.lineWidth = 2;
        ctx.strokeRect(1, 1, W - 2, H - 2);
    }

    /* ==================== GAME LOOP ==================== */
    function physicsStep(dt) {
        for (const p of players) p.update(dt);
        for (const a of arrows) a.update(dt);
        for (const s of shurikens) s.update(dt);
        arrows = arrows.filter(a => a.alive);
        shurikens = shurikens.filter(s => s.alive);

        for (const p of particles) p.update(dt);
        particles = particles.filter(p => p.life > 0);

        for (const d of damageNumbers) d.update(dt);
        damageNumbers = damageNumbers.filter(d => d.life > 0);

        checkCollisions();
        handleDeaths();
        checkWin();
    }

    function render(alpha) {
        drawArena();
        for (const a of arrows) a.draw(alpha);
        for (const s of shurikens) s.draw(alpha);
        for (const p of players) p.draw(alpha);
        for (const p of particles) p.draw();
        for (const d of damageNumbers) d.draw();
    }

    function loop(now) {
        requestAnimationFrame(loop);

        const frame = Math.min((now - lastTime) / 1000, MAX_FRAME);
        lastTime = now;

        // Espectador online: renderiza los snapshots del anfitrión
        if (netRole === "spectator") {
            spectatorFrame(frame);
            return;
        }

        if (started && !gameOver) {
            // Eased slow-motion on impacts instead of a hard freeze
            const targetScale = hitStopTimer > 0 ? 0.1 : 1;
            if (hitStopTimer > 0) hitStopTimer -= frame;
            timeScale += (targetScale - timeScale) * Math.min(1, frame * 18);

            // Fixed-timestep simulation: identical speed at any FPS
            accumulator = Math.min(accumulator + frame * timeScale, MAX_FRAME);
            while (accumulator >= PHYSICS_DT) {
                physicsStep(PHYSICS_DT);
                accumulator -= PHYSICS_DT;
            }

            // Anfitrión online: retransmite el estado ~30 veces/s
            if (netRole === "host" && now - lastStateSent > 33) {
                lastStateSent = now;
                wsSend({ t: "state", s: snapshotState() });
            }
        }

        // Interpolate rendering between the last two physics states
        const alpha = started && !gameOver ? accumulator / PHYSICS_DT : 1;
        render(alpha);
    }

    /* ==================== EVENTS ==================== */
    document.getElementById("btn-restart").addEventListener("click", () => {
        if (mode === "online") leaveRoom();
        else init();
    });

    document.getElementById("btn-play-again").addEventListener("click", () => {
        if (mode === "online") {
            if (online && online.selfId === online.hostId) wsSend({ t: "toLobby" });
        } else {
            init();
        }
    });

    /* ==================== ONLINE MULTIPLAYER ==================== */
    const modeOverlay = document.getElementById("mode-overlay");
    const onlineOverlay = document.getElementById("online-overlay");
    const onlineCard = document.getElementById("online-card");
    let myName = localStorage.getItem("bp-name") || "";
    let joinCode = "";

    document.getElementById("btn-mode-local").addEventListener("click", () => {
        mode = "local";
        modeOverlay.classList.add("hidden");
        document.getElementById("btn-restart").textContent = "⟳ Reiniciar";
        init();
    });

    document.getElementById("btn-mode-online").addEventListener("click", () => {
        mode = "online";
        modeOverlay.classList.add("hidden");
        onlineOverlay.classList.remove("hidden");
        document.getElementById("btn-restart").textContent = "🚪 Salir de la sala";
        renderOnlineCard();
    });

    function wsSend(msg) {
        if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
    }

    function connect(onOpen) {
        if (ws && ws.readyState === 1) { onOpen(); return; }
        const proto = location.protocol === "https:" ? "wss" : "ws";
        try {
            ws = new WebSocket(`${proto}://${location.host}`);
        } catch {
            onlineError = "No se pudo conectar al servidor";
            renderOnlineCard();
            return;
        }
        ws.onopen = onOpen;
        ws.onmessage = (ev) => {
            let msg;
            try { msg = JSON.parse(ev.data); } catch { return; }
            handleServerMsg(msg);
        };
        ws.onclose = () => {
            if (mode !== "online") return;
            ws = null;
            online = null;
            netRole = null;
            started = false;
            lastSnap = null;
            onlineError = "Conexión perdida. ¿Está arrancado el servidor? (npm start)";
            document.getElementById("winner-overlay").classList.add("hidden");
            onlineOverlay.classList.remove("hidden");
            renderOnlineCard();
        };
    }

    function leaveRoom() {
        if (ws) {
            ws.onclose = null;
            ws.close();
        }
        ws = null;
        online = null;
        netRole = null;
        lastSnap = null;
        myProposal = null;
        myBet = { target: null, amount: 0 };
        onlineError = "";
        mode = null;
        onlineOverlay.classList.add("hidden");
        modeOverlay.classList.remove("hidden");
        document.getElementById("btn-restart").textContent = "⟳ Reiniciar";
        init();
    }

    function selfPlayer() {
        return online ? online.players.find(p => p.id === online.selfId) : null;
    }

    function isSelfHost() {
        return online && online.selfId === online.hostId;
    }

    function handleServerMsg(msg) {
        switch (msg.t) {
            case "joined":
                online = {
                    selfId: msg.selfId, code: msg.code, hostId: msg.hostId,
                    phase: msg.phase, players: msg.players,
                    roster: msg.roster, rosterBy: msg.rosterBy,
                };
                onlineError = "";
                if (msg.phase === "battle" && msg.roster) {
                    // Entramos con un combate en marcha: mirar como espectador
                    netRole = "spectator";
                    startOnlineBattle(msg.roster);
                } else {
                    renderOnlineCard();
                }
                break;

            case "room": {
                if (!online) return;
                const prevPhase = online.phase;
                online.players = msg.players;
                online.hostId = msg.hostId;
                online.phase = msg.phase;
                online.roster = msg.roster;
                online.rosterBy = msg.rosterBy;
                if (msg.phase === "proposals" || msg.phase === "betting") {
                    if (msg.phase === "betting" && prevPhase !== "betting") {
                        myBet = { target: null, amount: 0 };
                    }
                    started = false;
                    netRole = null;
                    lastSnap = null;
                    document.getElementById("winner-overlay").classList.add("hidden");
                    onlineOverlay.classList.remove("hidden");
                    renderOnlineCard();
                } else if (msg.phase === "result" && isSelfHost()) {
                    // Heredamos la sala en la pantalla de resultados: desbloquear el botón
                    const again = document.getElementById("btn-play-again");
                    again.disabled = false;
                    again.textContent = "Volver a la sala";
                }
                break;
            }

            case "gameStart":
                if (!online) return;
                online.phase = "battle";
                online.players = msg.players;
                online.hostId = msg.hostId;
                online.roster = msg.roster;
                online.rosterBy = msg.rosterBy;
                netRole = isSelfHost() ? "host" : "spectator";
                startOnlineBattle(msg.roster);
                break;

            case "state":
                if (netRole === "spectator" && started) applySnapshot(msg.s);
                break;

            case "result":
                if (!online) return;
                online.phase = "result";
                online.players = msg.players;
                showOnlineResult(msg);
                break;

            case "aborted":
                onlineError = msg.msg || "Combate cancelado";
                started = false;
                netRole = null;
                lastSnap = null;
                document.getElementById("winner-overlay").classList.add("hidden");
                break;

            case "error":
                onlineError = msg.msg || "Error";
                renderOnlineCard();
                break;
        }
    }

    /* ---------- Battle sync ---------- */
    function startOnlineBattle(rosterArr) {
        roster = rosterArr.map(w => ({ weapon: w }));
        init();
        onlineOverlay.classList.add("hidden");
        document.getElementById("winner-overlay").classList.add("hidden");
        lastSnap = null;
        started = true;
        lastTime = performance.now();
        if (netRole === "host") {
            for (const p of players) {
                const a = Math.random() * Math.PI * 2;
                p.vx = Math.cos(a) * INITIAL_SPEED;
                p.vy = Math.sin(a) * INITIAL_SPEED;
                p.baseSpeed = INITIAL_SPEED;
            }
        }
    }

    /* Estado compacto que el anfitrión retransmite */
    function snapshotState() {
        const r1 = (v) => Math.round(v * 10) / 10;
        const r2 = (v) => Math.round(v * 100) / 100;
        return {
            w: W, h: H,
            p: players.map(p => [p.index, r1(p.x), r1(p.y), r2(p.weaponAngle), r1(p.hp), statValueOf(p)]),
            a: arrows.map(a => [r1(a.x), r1(a.y), r2(a.angle)]),
            s: shurikens.map(s => [r1(s.x), r1(s.y), r2(s.spin)]),
        };
    }

    function applySnapshot(s) {
        lastSnap = s;
        const seen = new Set();
        for (const [i, x, y, a, hp, stat] of s.p) {
            seen.add(i);
            const p = players.find(q => q.index === i);
            if (!p) continue;
            p.px = p.x; p.py = p.y;
            p.prevWeaponAngle = p.weaponAngle;
            p.x = x; p.y = y;
            p.weaponAngle = a;
            if (hp < p.hp) {
                spawnHitParticles(x, y, p.color.fill);
                damageNumbers.push(new DamageNumber(x, y - BALL_RADIUS - 20, Math.round((p.hp - hp) * 10) / 10));
                p.flashTimer = 0.12;
            }
            p.hp = hp;
            const prevStat = statValueOf(p);
            if (p.type === "sword") p.damage = stat;
            else if (p.type === "bow") p.burstSize = stat;
            else if (p.type === "shield") p.shieldSize = stat;
            else p.shurikenBounces = stat;
            if (stat !== prevStat) updateStatValue(p);
        }
        for (const p of players) {
            if (!seen.has(p.index)) {
                spawnHitParticles(p.x, p.y, p.color.fill);
                spawnHitParticles(p.x, p.y, p.color.light);
                markDead(p);
            }
        }
        players = players.filter(p => seen.has(p.index));
        arrows = s.a.map(([x, y, ang]) => {
            const a = new Arrow(x, y, ang, 0, null);
            a.px = x; a.py = y;
            return a;
        });
        shurikens = s.s.map(([x, y, spin]) => {
            const sh = new Shuriken(x, y, 0, null);
            sh.px = x; sh.py = y;
            sh.vx = 0; sh.vy = 0;
            sh.spin = spin; sh.prevSpin = spin;
            return sh;
        });
    }

    /* Frame del espectador: efectos locales + render escalado a la arena del anfitrión */
    function spectatorFrame(frame) {
        for (const p of players) {
            if (p.flashTimer > 0) p.flashTimer -= frame;
        }
        for (const pt of particles) pt.update(frame);
        particles = particles.filter(p => p.life > 0);
        for (const d of damageNumbers) d.update(frame);
        damageNumbers = damageNumbers.filter(d => d.life > 0);

        drawArena();
        const scale = lastSnap ? W / lastSnap.w : 1;
        ctx.save();
        ctx.scale(scale, scale);
        for (const a of arrows) a.draw(1);
        for (const s of shurikens) s.draw(1);
        for (const p of players) p.draw(1);
        for (const p of particles) p.draw();
        for (const d of damageNumbers) d.draw();
        ctx.restore();
    }

    /* ---------- Result overlay (online) ---------- */
    function showOnlineResult(msg) {
        started = false;
        gameOver = true;
        const overlay = document.getElementById("winner-overlay");
        const winText = document.getElementById("winner-text");
        const resultEl = document.getElementById("bet-result");

        if (msg.winner !== null && online.roster && online.roster[msg.winner]) {
            const w = online.roster[msg.winner];
            winText.textContent = `${WEAPON_DEFS[w].icon} ¡J${msg.winner + 1} (${WEAPON_DEFS[w].label}) gana!`;
            winText.style.color = PALETTE[msg.winner % PALETTE.length].fill;
        } else {
            winText.textContent = "¡Empate!";
            winText.style.color = "#f0ece4";
        }

        resultEl.innerHTML = "";
        for (const line of msg.lines) {
            const el = document.createElement("div");
            el.className = "bet-result-line";
            el.textContent = `🪙 ${line.name}: ${line.text}`;
            el.style.color = line.kind === "win" ? "#44cc55" : line.kind === "lose" ? "#ff4455" : "#f0ece4";
            resultEl.appendChild(el);
        }
        const sorted = [...msg.players].sort((a, b) => b.coins - a.coins);
        const standing = document.createElement("div");
        standing.className = "bet-standing";
        standing.textContent = "🏆 " + sorted.map(p => `${p.name}: ${p.coins}`).join(" · ");
        resultEl.appendChild(standing);

        const again = document.getElementById("btn-play-again");
        if (isSelfHost()) {
            again.disabled = false;
            again.textContent = "Volver a la sala";
        } else {
            again.disabled = true;
            again.textContent = "Esperando al anfitrión…";
        }
        overlay.classList.remove("hidden");
    }

    /* ---------- Online UI ---------- */
    function el(tag, cls, text) {
        const e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text !== undefined) e.textContent = text;
        return e;
    }

    function renderOnlineCard() {
        onlineCard.innerHTML = "";
        if (!online) renderConnectForm();
        else if (online.phase === "betting") renderBettingPhase();
        else renderLobbyPhase();
    }

    function renderConnectForm() {
        onlineCard.appendChild(el("h2", "online-title", "🌐 Juego online"));

        const nameInput = el("input", "online-input");
        nameInput.placeholder = "Tu nombre";
        nameInput.maxLength = 16;
        nameInput.value = myName;
        nameInput.addEventListener("input", () => {
            myName = nameInput.value;
            localStorage.setItem("bp-name", myName);
        });
        onlineCard.appendChild(nameInput);

        const createBtn = el("button", "online-btn primary", "➕ Crear sala");
        createBtn.addEventListener("click", () => {
            if (!myName.trim()) { onlineError = "Escribe tu nombre primero"; renderOnlineCard(); return; }
            onlineError = "";
            connect(() => wsSend({ t: "create", name: myName }));
        });
        onlineCard.appendChild(createBtn);

        onlineCard.appendChild(el("div", "online-divider", "o únete a una"));

        const joinRow = el("div", "online-row");
        const codeInput = el("input", "online-input code-input");
        codeInput.placeholder = "CÓDIGO";
        codeInput.maxLength = 4;
        codeInput.value = joinCode;
        codeInput.addEventListener("input", () => {
            joinCode = codeInput.value.toUpperCase();
            codeInput.value = joinCode;
        });
        joinRow.appendChild(codeInput);
        const joinBtn = el("button", "online-btn", "Unirse");
        joinBtn.addEventListener("click", () => {
            if (!myName.trim()) { onlineError = "Escribe tu nombre primero"; renderOnlineCard(); return; }
            if (joinCode.trim().length !== 4) { onlineError = "El código tiene 4 letras"; renderOnlineCard(); return; }
            onlineError = "";
            connect(() => wsSend({ t: "join", code: joinCode, name: myName }));
        });
        joinRow.appendChild(joinBtn);
        onlineCard.appendChild(joinRow);

        onlineCard.appendChild(el("div", "online-error", onlineError));

        const backBtn = el("button", "online-btn subtle", "← Volver");
        backBtn.addEventListener("click", leaveRoom);
        onlineCard.appendChild(backBtn);
    }

    function renderPlayerList(showBets) {
        const list = el("div");
        list.style.display = "flex";
        list.style.flexDirection = "column";
        list.style.gap = "6px";
        for (const p of online.players) {
            const row = el("div", "lobby-row");
            const name = el("span", "lobby-name",
                `${p.id === online.hostId ? "👑 " : ""}${p.name}${p.id === online.selfId ? " (tú)" : ""}`);
            row.appendChild(name);
            if (showBets) {
                const betTxt = p.bet
                    ? `${WEAPON_DEFS[online.roster[p.bet.target]].icon} J${p.bet.target + 1} · ${p.bet.amount}`
                    : "sin apuesta";
                row.appendChild(el("span", "lobby-badge" + (p.bet ? " bet" : ""), betTxt));
            } else {
                row.appendChild(el("span", "lobby-badge", p.hasProposal ? "✏️ propone" : "🎲 aleatoria"));
            }
            row.appendChild(el("span", "lobby-coins", `🪙 ${p.coins}`));
            list.appendChild(row);
        }
        return list;
    }

    function renderRoomHeader() {
        const title = el("h2", "online-title");
        title.appendChild(el("span", "", "Sala"));
        const code = el("span", "code-badge", online.code);
        code.title = "Copiar código";
        code.addEventListener("click", () => {
            navigator.clipboard && navigator.clipboard.writeText(online.code);
            code.textContent = "¡Copiado!";
            setTimeout(() => { code.textContent = online.code; }, 900);
        });
        title.appendChild(code);
        onlineCard.appendChild(title);
    }

    /* Fase 1: cada jugador propone (o no) una disposición */
    function renderLobbyPhase() {
        renderRoomHeader();
        onlineCard.appendChild(el("p", "online-hint",
            "Comparte el código con tus amigos. Cada uno puede proponer una disposición de bolas: al sortear se elige una al azar."));
        onlineCard.appendChild(renderPlayerList(false));

        onlineCard.appendChild(el("div", "subheading", "Tu propuesta de disposición"));
        const toggle = el("div", "proposal-toggle");
        const randChip = el("button", "bet-chip" + (myProposal === null ? " selected" : ""), "🎲 Aleatoria");
        randChip.addEventListener("click", () => {
            myProposal = null;
            wsSend({ t: "propose", roster: null });
            renderOnlineCard();
        });
        toggle.appendChild(randChip);
        const customChip = el("button", "bet-chip" + (myProposal !== null ? " selected" : ""), "✏️ Personalizada");
        customChip.addEventListener("click", () => {
            if (myProposal === null) {
                myProposal = ["sword", "bow"];
                wsSend({ t: "propose", roster: myProposal });
            }
            renderOnlineCard();
        });
        toggle.appendChild(customChip);
        onlineCard.appendChild(toggle);

        if (myProposal !== null) onlineCard.appendChild(renderProposalEditor());

        if (isSelfHost()) {
            const rollBtn = el("button", "online-btn primary", "🎲 Sortear disposición");
            rollBtn.addEventListener("click", () => wsSend({ t: "roll" }));
            onlineCard.appendChild(rollBtn);
        } else {
            onlineCard.appendChild(el("div", "waiting-note", "Esperando a que el anfitrión sortee la disposición…"));
        }

        onlineCard.appendChild(el("div", "online-error", onlineError));
        onlineError = "";
    }

    function renderProposalEditor() {
        const box = el("div");
        box.style.display = "flex";
        box.style.flexDirection = "column";
        box.style.gap = "6px";

        myProposal.forEach((weapon, i) => {
            const row = el("div", "player-row");
            const dot = el("span", "player-dot");
            dot.style.background = PALETTE[i % PALETTE.length].fill;
            row.appendChild(dot);
            row.appendChild(el("span", "player-name", `J${i + 1}`));

            const picker = el("div", "weapon-picker");
            for (const [key, def] of Object.entries(WEAPON_DEFS)) {
                const btn = el("button", "weapon-btn" + (weapon === key ? " selected" : ""), def.icon);
                btn.title = `${def.label} — ${def.desc}`;
                btn.addEventListener("click", () => {
                    myProposal[i] = key;
                    wsSend({ t: "propose", roster: myProposal });
                    renderOnlineCard();
                });
                picker.appendChild(btn);
            }
            row.appendChild(picker);

            const remove = el("button", "remove-btn", "✕");
            remove.disabled = myProposal.length <= MIN_PLAYERS;
            remove.addEventListener("click", () => {
                myProposal.splice(i, 1);
                wsSend({ t: "propose", roster: myProposal });
                renderOnlineCard();
            });
            row.appendChild(remove);
            box.appendChild(row);
        });

        const addBtn = el("button", "online-btn", "+ Añadir bola");
        addBtn.disabled = myProposal.length >= MAX_PLAYERS;
        addBtn.addEventListener("click", () => {
            myProposal.push("shuriken");
            wsSend({ t: "propose", roster: myProposal });
            renderOnlineCard();
        });
        box.appendChild(addBtn);
        return box;
    }

    /* Fase 2: disposición sorteada, cada jugador apuesta a una bola */
    function renderBettingPhase() {
        renderRoomHeader();
        onlineCard.appendChild(el("p", "online-hint",
            online.rosterBy
                ? `Ha salido la propuesta de ${online.rosterBy}. ¡Haced vuestras apuestas!`
                : "Disposición aleatoria. ¡Haced vuestras apuestas!"));

        const chips = el("div", "roster-chips");
        online.roster.forEach((w, i) => {
            const chip = el("button", "bet-chip" + (myBet.target === i ? " selected" : ""),
                `${WEAPON_DEFS[w].icon} J${i + 1} ${WEAPON_DEFS[w].label}`);
            chip.style.borderColor = PALETTE[i % PALETTE.length].fill;
            chip.addEventListener("click", () => {
                myBet.target = i;
                wsSend({ t: "bet", target: myBet.target, amount: myBet.amount });
                renderOnlineCard();
            });
            chips.appendChild(chip);
        });
        const noneChip = el("button", "bet-chip" + (myBet.target === null ? " selected" : ""), "Sin apuesta");
        noneChip.addEventListener("click", () => {
            myBet.target = null;
            wsSend({ t: "bet", target: null, amount: 0 });
            renderOnlineCard();
        });
        chips.appendChild(noneChip);
        onlineCard.appendChild(chips);

        const self = selfPlayer();
        const maxCoins = self ? self.coins : 0;
        const amountRow = el("div", "bet-amount-row");
        for (const delta of [-10, -1]) {
            const b = el("button", "bet-adj", `−${-delta}`);
            b.addEventListener("click", () => adjustBet(delta, maxCoins));
            amountRow.appendChild(b);
        }
        amountRow.appendChild(el("span", "bet-amount", String(myBet.amount)));
        for (const delta of [1, 10]) {
            const b = el("button", "bet-adj", `+${delta}`);
            b.addEventListener("click", () => adjustBet(delta, maxCoins));
            amountRow.appendChild(b);
        }
        onlineCard.appendChild(amountRow);

        const mult = online.roster.length;
        onlineCard.appendChild(el("div", "bet-multiplier",
            myBet.target !== null && myBet.amount > 0 ? `Premio: ${myBet.amount * mult} (x${mult})` : ""));

        onlineCard.appendChild(el("div", "subheading", "Apuestas de la sala"));
        onlineCard.appendChild(renderPlayerList(true));

        if (isSelfHost()) {
            const startBtn = el("button", "online-btn primary", "▶ ¡Empezar combate!");
            startBtn.addEventListener("click", () => wsSend({ t: "begin" }));
            onlineCard.appendChild(startBtn);
            const rerollBtn = el("button", "online-btn subtle", "🎲 Volver a sortear");
            rerollBtn.addEventListener("click", () => wsSend({ t: "roll" }));
            onlineCard.appendChild(rerollBtn);
        } else {
            onlineCard.appendChild(el("div", "waiting-note", "Esperando a que el anfitrión empiece el combate…"));
        }

        onlineCard.appendChild(el("div", "online-error", onlineError));
        onlineError = "";
    }

    function adjustBet(delta, maxCoins) {
        myBet.amount = Math.max(0, Math.min(myBet.amount + delta, maxCoins + 10));
        if (myBet.target !== null) {
            wsSend({ t: "bet", target: myBet.target, amount: myBet.amount });
        }
        renderOnlineCard();
    }

    /* ==================== START ==================== */
    init();
    requestAnimationFrame(loop);
})();
