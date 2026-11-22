// Tiny stack VM for make.fun's tiny stack ISA v1 (kit ISA.md): runs every
// program.bin + input.bin under the input dir, writing stdout.bin + exit.txt
// per instance (32-bit wrap math, 256-value stack, 64-deep calls, 256 words
// of memory, all ten traps, step/output limits).
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SMAX = 256, CMAX = 64, MWORDS = 256, STEPS = 1_000_000, OUTMAX = 65_536;

const LOWPOPS = [0, 0, 0, 1, 1, 2, 2, 3];
const LOWPUSH = [0, 1, 1, 0, 2, 2, 3, 3];

function run(prog: Uint8Array, input: Uint8Array): { out: Uint8Array; code: number } {
  const d = new Int32Array(SMAX);
  const calls = new Int32Array(CMAX);
  const mem = new Int32Array(MWORDS);
  const out = new Uint8Array(OUTMAX);
  let sp = 0, cp = 0, pc = 0, steps = 0, olen = 0, ipos = 0;
  const end = (code: number) => ({ out: out.slice(0, olen), code });
  for (;;) {
    // Step limit and pc bound are checked before reading the opcode.
    if (steps === STEPS) return end(10);
    if (pc < 0 || pc >= prog.length) return end(9);
    const op = prog[pc];
    let imm = 0, need = 0, give = 0;
    if (op < 8) {
      imm = op === 1 ? 1 : op === 2 ? 4 : 0;
      need = LOWPOPS[op];
      give = LOWPUSH[op];
    } else if (op >= 0x10 && op <= 0x22) {
      need = op === 0x17 || op === 0x1b ? 1 : 2;
      give = 1;
    } else if (op >= 0x30 && op <= 0x34) {
      imm = op === 0x34 ? 0 : 2;
      need = op === 0x31 || op === 0x32 ? 1 : 0;
    } else if (op === 0x40) {
      need = 1;
      give = 1;
    } else if (op === 0x41) {
      need = 2;
    } else if (op >= 0x50 && op <= 0x53) {
      need = op === 0x52 ? 0 : 1;
      give = op === 0x52 ? 1 : 0;
    } else {
      return end(5);
    }
    if (pc + imm >= prog.length) return end(9);
    steps++;
    if (sp < need) return end(2);
    if (sp - need + give > SMAX) return end(3);
    const nx = pc + 1 + imm;
    pc = nx;
    switch (op) {
      case 0x00:
        return end(0);
      case 0x01:
        d[sp++] = (prog[nx - 1] << 24) >> 24;
        break;
      case 0x02:
        d[sp++] = prog[nx - 4] | (prog[nx - 3] << 8) | (prog[nx - 2] << 16) | (prog[nx - 1] << 24);
        break;
      case 0x03:
        sp--;
        break;
      case 0x04:
        d[sp] = d[sp - 1];
        sp++;
        break;
      case 0x05: {
        const t = d[sp - 1];
        d[sp - 1] = d[sp - 2];
        d[sp - 2] = t;
        break;
      }
      case 0x06:
        d[sp] = d[sp - 2];
        sp++;
        break;
      case 0x07: {
        const t = d[sp - 3];
        d[sp - 3] = d[sp - 2];
        d[sp - 2] = d[sp - 1];
        d[sp - 1] = t;
        break;
      }
      case 0x17:
        d[sp - 1] = (-d[sp - 1]) | 0;
        break;
      case 0x1b:
        d[sp - 1] = ~d[sp - 1];
        break;
      case 0x30:
      case 0x31:
      case 0x32: {
        const rel = ((prog[nx - 2] | (prog[nx - 1] << 8)) << 16) >> 16;
        if (op === 0x30) {
          pc = nx + rel;
        } else {
          const v = d[--sp];
          if ((op === 0x31) === (v === 0)) pc = nx + rel;
        }
        break;
      }
      case 0x33:
        if (cp === CMAX) return end(7);
        calls[cp++] = nx;
        pc = prog[nx - 2] | (prog[nx - 1] << 8);
        break;
      case 0x34:
        if (cp === 0) return end(8);
        pc = calls[--cp];
        break;
      case 0x40: {
        const a = d[sp - 1];
        if (a < 0 || a >= MWORDS) return end(6);
        d[sp - 1] = mem[a];
        break;
      }
      case 0x41: {
        const a = d[sp - 1];
        const v = d[sp - 2];
        if (a < 0 || a >= MWORDS) return end(6);
        sp -= 2;
        mem[a] = v;
        break;
      }
      case 0x50: {
        const s = String(d[sp - 1]);
        if (olen + s.length > OUTMAX) return end(11);
        sp--;
        for (let i = 0; i < s.length; i++) out[olen++] = s.charCodeAt(i);
        break;
      }
      case 0x51:
        if (olen + 1 > OUTMAX) return end(11);
        out[olen++] = d[--sp] & 255;
        break;
      case 0x52:
        d[sp++] = ipos < input.length ? input[ipos++] : -1;
        break;
      case 0x53:
        return end(d[--sp] & 255);
      default: {
        const b = d[sp - 1];
        const a = d[sp - 2];
        let r = 0;
        if (op === 0x10) r = (a + b) | 0;
        else if (op === 0x11) r = (a - b) | 0;
        else if (op === 0x12) r = Math.imul(a, b);
        else if (op === 0x13) {
          if (b === 0) return end(4);
          r = a === -2147483648 && b === -1 ? a : (a / b) | 0;
        } else if (op === 0x14) {
          if (b === 0) return end(4);
          r = b === -1 ? 0 : (a % b) | 0;
        } else if (op === 0x15) {
          if (b === 0) return end(4);
          r = Math.floor((a >>> 0) / (b >>> 0)) | 0;
        } else if (op === 0x16) {
          if (b === 0) return end(4);
          r = ((a >>> 0) % (b >>> 0)) | 0;
        } else if (op === 0x18) r = a & b;
        else if (op === 0x19) r = a | b;
        else if (op === 0x1a) r = a ^ b;
        else if (op === 0x1c) r = a << (b & 31);
        else if (op === 0x1d) r = a >> (b & 31);
        else if (op === 0x1e) r = (a >>> (b & 31)) | 0;
        else if (op === 0x20) r = a === b ? 1 : 0;
        else if (op === 0x21) r = a < b ? 1 : 0;
        else r = (a >>> 0) < (b >>> 0) ? 1 : 0;
        sp -= 2;
        d[sp++] = r;
        break;
      }
    }
  }
}

const IN = process.env.MAKEFUN_INPUT_DIR ?? "/input";
const OUT = process.env.MAKEFUN_OUTPUT_DIR ?? "/output";
for (const id of readdirSync(IN).sort()) {
  const r = run(
    new Uint8Array(readFileSync(join(IN, id, "program.bin"))),
    new Uint8Array(readFileSync(join(IN, id, "input.bin"))),
  );
  mkdirSync(join(OUT, id), { recursive: true });
  writeFileSync(join(OUT, id, "stdout.bin"), r.out);
  writeFileSync(join(OUT, id, "exit.txt"), `${r.code}\n`);
}
