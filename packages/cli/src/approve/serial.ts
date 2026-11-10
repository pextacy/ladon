/** Line-oriented serial link to the Ladon Key (USB CDC, 115200, newline-delimited JSON). */
export interface SerialLink {
  write(line: string): Promise<void>;
  onLine(cb: (line: string) => void): () => void;
  close(): Promise<void>;
  readonly path: string;
}

const ESPRESSIF_VID = "303a";

export async function listKeyPorts(): Promise<{ path: string; label: string }[]> {
  const sp = await import("serialport").catch(() => null);
  if (!sp) return [];
  const ports = await sp.SerialPort.list();
  return ports
    .filter((p) => (p.vendorId ?? "").toLowerCase() === ESPRESSIF_VID || /espressif|ladon/i.test(`${p.manufacturer ?? ""} ${(p as { product?: string }).product ?? ""}`))
    .map((p) => ({ path: p.path, label: `${p.manufacturer ?? "USB"} ${p.serialNumber ?? ""}`.trim() }));
}

export async function openSerial(path: string): Promise<SerialLink> {
  const sp = await import("serialport").catch(() => null);
  if (!sp) throw new Error("serial support not installed (optional dependency `serialport`)");
  const port = new sp.SerialPort({ path, baudRate: 115200, autoOpen: false });
  await new Promise<void>((resolve, reject) => port.open((err) => (err ? reject(err) : resolve())));
  const parser = port.pipe(new sp.ReadlineParser({ delimiter: "\n" }));
  const listeners = new Set<(l: string) => void>();
  parser.on("data", (d: string) => {
    const line = d.trim();
    if (line) for (const l of listeners) l(line);
  });
  return {
    path,
    write: (line) => new Promise((resolve, reject) => port.write(line + "\n", (err) => (err ? reject(err) : port.drain(() => resolve())))),
    onLine(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    close: () => new Promise((resolve) => (port.isOpen ? port.close(() => resolve()) : resolve())),
  };
}
