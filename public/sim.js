// ============================================================
// sim.js — Physics engine + PID controller
// ============================================================

export class Pendulum {
  constructor({ L = 10, m = 50, b = 1.2 } = {}) {
    this.L = L;
    this.m = m;
    this.b = b;
    this.state = { theta_x: 0, theta_y: 0, omega_x: 0, omega_y: 0 };
  }

  _derivatives(state, F_wind_x, F_wind_y, F_prop_x, F_prop_y) {
    const { omega_x, omega_y, theta_x, theta_y } = state;
    const { m, L, b } = this;
    const G = 9.81;
    const domega_x = (F_wind_x - b * omega_x - m * G * theta_x - F_prop_x) / (m * L);
    const domega_y = (F_wind_y - b * omega_y - m * G * theta_y - F_prop_y) / (m * L);
    return { dtheta_x: omega_x, dtheta_y: omega_y, domega_x, domega_y };
  }

  step(dt, F_wind_x, F_wind_y, F_prop_x, F_prop_y) {
    const s = this.state;

    // Runge-Kutta 4th order
    const k1 = this._derivatives(s, F_wind_x, F_wind_y, F_prop_x, F_prop_y);

    const s2 = {
      theta_x: s.theta_x + 0.5 * dt * k1.dtheta_x,
      theta_y: s.theta_y + 0.5 * dt * k1.dtheta_y,
      omega_x: s.omega_x + 0.5 * dt * k1.domega_x,
      omega_y: s.omega_y + 0.5 * dt * k1.domega_y,
    };
    const k2 = this._derivatives(s2, F_wind_x, F_wind_y, F_prop_x, F_prop_y);

    const s3 = {
      theta_x: s.theta_x + 0.5 * dt * k2.dtheta_x,
      theta_y: s.theta_y + 0.5 * dt * k2.dtheta_y,
      omega_x: s.omega_x + 0.5 * dt * k2.domega_x,
      omega_y: s.omega_y + 0.5 * dt * k2.domega_y,
    };
    const k3 = this._derivatives(s3, F_wind_x, F_wind_y, F_prop_x, F_prop_y);

    const s4 = {
      theta_x: s.theta_x + dt * k3.dtheta_x,
      theta_y: s.theta_y + dt * k3.dtheta_y,
      omega_x: s.omega_x + dt * k3.domega_x,
      omega_y: s.omega_y + dt * k3.domega_y,
    };
    const k4 = this._derivatives(s4, F_wind_x, F_wind_y, F_prop_x, F_prop_y);

    this.state.theta_x += (dt / 6) * (k1.dtheta_x + 2*k2.dtheta_x + 2*k3.dtheta_x + k4.dtheta_x);
    this.state.theta_y += (dt / 6) * (k1.dtheta_y + 2*k2.dtheta_y + 2*k3.dtheta_y + k4.dtheta_y);
    this.state.omega_x += (dt / 6) * (k1.domega_x + 2*k2.domega_x + 2*k3.domega_x + k4.domega_x);
    this.state.omega_y += (dt / 6) * (k1.domega_y + 2*k2.domega_y + 2*k3.domega_y + k4.domega_y);

    // Clamp to physically reasonable range (prevent numerical blow-up)
    const MAX_ANGLE = Math.PI / 2;
    this.state.theta_x = Math.max(-MAX_ANGLE, Math.min(MAX_ANGLE, this.state.theta_x));
    this.state.theta_y = Math.max(-MAX_ANGLE, Math.min(MAX_ANGLE, this.state.theta_y));
  }

  reset() {
    this.state = { theta_x: 0, theta_y: 0, omega_x: 0, omega_y: 0 };
  }
}

// ============================================================

export class PIDController {
  constructor({ Kp = 8.0, Ki = 0.1, Kd = 2.5 } = {}) {
    this.Kp = Kp;
    this.Ki = Ki;
    this.Kd = Kd;
    this._integral = 0;
    this._prevError = 0;
    this._INTEGRAL_CLAMP = 50;
  }

  compute(error, dt) {
    this._integral += error * dt;
    this._integral = Math.max(-this._INTEGRAL_CLAMP, Math.min(this._INTEGRAL_CLAMP, this._integral));
    const derivative = (error - this._prevError) / Math.max(dt, 1e-6);
    this._prevError = error;
    return this.Kp * error + this.Ki * this._integral + this.Kd * derivative;
  }

  reset() {
    this._integral = 0;
    this._prevError = 0;
  }
}

// ============================================================

export class PropellerMixer {
  constructor() {
    this.PWM_IDLE = 0.0;
    this.scale = 0.15;
    // pwm[0]=N, pwm[1]=E, pwm[2]=S, pwm[3]=W
    this.pwm = [0, 0, 0, 0];
  }

  mix(Fx, Fy, yaw) {
    // Body-frame yaw correction
    const Fx_body =  Fx * Math.cos(yaw) + Fy * Math.sin(yaw);
    const Fy_body = -Fx * Math.sin(yaw) + Fy * Math.cos(yaw);

    const raw = [
      this.PWM_IDLE + Fy_body * this.scale,   // M1 N
      this.PWM_IDLE + Fx_body * this.scale,   // M2 E
      this.PWM_IDLE - Fy_body * this.scale,   // M3 S
      this.PWM_IDLE - Fx_body * this.scale,   // M4 W
    ];

    this.pwm = raw.map(v => Math.max(-1, Math.min(1, v)));
    return this.pwm;
  }

  // Returns force components (in world frame) from current PWM
  getForce(yaw) {
    const [m1, m2, m3, m4] = this.pwm;
    const Fy_body = (m1 - m3) / (2 * this.scale);
    const Fx_body = (m2 - m4) / (2 * this.scale);
    const Fx =  Fx_body * Math.cos(yaw) - Fy_body * Math.sin(yaw);
    const Fy =  Fx_body * Math.sin(yaw) + Fy_body * Math.cos(yaw);
    return { Fx, Fy };
  }

  reset() {
    this.pwm = [0, 0, 0, 0];
  }
}

// ============================================================
// Export via window for non-module scripts (Three.js compat)
window.__sim = { Pendulum, PIDController, PropellerMixer };
