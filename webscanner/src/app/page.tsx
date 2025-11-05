"use client";

import { useCallback, useMemo, useRef, useState } from "react";

type PortStatus = "open" | "closed" | "timeout" | "error";

type ProtocolHint = "http" | "https";

interface PortResult {
  port: number;
  protocol: ProtocolHint;
  status: PortStatus;
  latency?: number;
  errorMessage?: string;
}

interface HostResult {
  ip: string;
  ports: PortResult[];
  responded: boolean;
}

interface ScanProgress {
  current: number;
  total: number;
}

const COMMON_PORT_PROFILES: Record<string, number[]> = {
  "Web & Serviços": [80, 443, 8080, 8443],
  "Administrativo": [22, 3389, 5900, 5985],
  "Compartilhamento": [139, 445, 548, 2049],
  "Dispositivos IoT": [1883, 5683, 8883],
};

const MAX_TARGETS = 2048;

const protocolForPort = (port: number): ProtocolHint =>
  port === 443 || port === 8443 || port === 9443 ? "https" : "http";

const ipToNumber = (ip: string) => {
  const parts = ip.trim().split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part))) {
    throw new Error("IP inválido");
  }
  return (
    parts[0] * 256 ** 3 + parts[1] * 256 ** 2 + parts[2] * 256 + parts[3]
  );
};

const numberToIp = (value: number) => {
  const a = Math.floor(value / 256 ** 3) % 256;
  const b = Math.floor(value / 256 ** 2) % 256;
  const c = Math.floor(value / 256) % 256;
  const d = value % 256;
  return [a, b, c, d].join(".");
};

const parsePorts = (value: string) => {
  const set = new Set<number>();
  value
    .split(/[,\s]+/)
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .forEach((chunk) => {
      const port = Number.parseInt(chunk, 10);
      if (!Number.isNaN(port) && port > 0 && port <= 65535) {
        set.add(port);
      }
    });
  return Array.from(set).sort((a, b) => a - b);
};

const buildTargetList = (start: string, end: string) => {
  const startValue = ipToNumber(start);
  const endValue = ipToNumber(end);
  if (endValue < startValue) {
    throw new Error("O IP final deve ser maior ou igual ao inicial.");
  }
  const total = endValue - startValue + 1;
  if (total > MAX_TARGETS) {
    throw new Error(
      `Limite máximo de ${MAX_TARGETS} endereços por varredura excedido.`,
    );
  }
  return new Array<number>(total)
    .fill(0)
    .map((_, index) => numberToIp(startValue + index));
};

const mapErrorToStatus = (error: unknown): PortStatus => {
  if (error instanceof DOMException && error.name === "AbortError") {
    return "timeout";
  }
  if (
    error instanceof TypeError &&
    error.message.toLowerCase().includes("fetch")
  ) {
    return "closed";
  }
  return "error";
};

export default function Home() {
  const [startIp, setStartIp] = useState("192.168.0.1");
  const [endIp, setEndIp] = useState("192.168.0.254");
  const [portsInput, setPortsInput] = useState("80,443,3389,445,22");
  const [timeoutMs, setTimeoutMs] = useState(2000);
  const [concurrency, setConcurrency] = useState(24);
  const [progress, setProgress] = useState<ScanProgress>({ current: 0, total: 0 });
  const [results, setResults] = useState<HostResult[]>([]);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [isScanning, setIsScanning] = useState(false);
  const controllersRef = useRef<AbortController[]>([]);
  const cancelRequestedRef = useRef(false);

  const orderedResults = useMemo(() => {
    return [...results].sort((a, b) => {
      if (a.responded === b.responded) {
        return a.ip.localeCompare(b.ip, undefined, { numeric: true });
      }
      return a.responded ? -1 : 1;
    });
  }, [results]);

  const stats = useMemo(() => {
    const totalHosts = results.length;
    const responsive = results.filter((item) =>
      item.ports.some((port) => port.status === "open"),
    ).length;
    const timeout = results.filter((item) =>
      item.ports.every((port) => port.status === "timeout"),
    ).length;
    return { totalHosts, responsive, timeout };
  }, [results]);

  const registerController = (controller: AbortController) => {
    controllersRef.current.push(controller);
    return () => {
      controllersRef.current = controllersRef.current.filter(
        (item) => item !== controller,
      );
    };
  };

  const scanPort = useCallback(
    async (ip: string, port: number): Promise<PortResult> => {
      const protocol = protocolForPort(port);
      const controller = new AbortController();
      const unregister = registerController(controller);
      const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);
      const startedAt = performance.now();
      const cacheBuster = Math.random().toString(36).slice(2);
      const url = `${protocol}://${ip}:${port}/?probe=${cacheBuster}`;

      try {
        await fetch(url, {
          method: "GET",
          mode: "no-cors",
          cache: "no-store",
          signal: controller.signal,
        });
        const latency = performance.now() - startedAt;
        window.clearTimeout(timeoutId);
        unregister();
        return {
          port,
          protocol,
          status: "open",
          latency: Math.round(latency),
        };
      } catch (error) {
        window.clearTimeout(timeoutId);
        unregister();
        const status = mapErrorToStatus(error);
        return {
          port,
          protocol,
          status,
          errorMessage:
            status === "error" ? (error as Error)?.message ?? "Erro desconhecido" : undefined,
        };
      }
    },
    [timeoutMs],
  );

  const scanHost = useCallback(
    async (ip: string, ports: number[]) => {
      const portResults = await Promise.all(ports.map((port) => scanPort(ip, port)));
      const responded =
        portResults.some((item) => item.status === "open") ||
        portResults.every((item) => item.status === "timeout");
      return { ip, ports: portResults, responded };
    },
    [scanPort],
  );

  const handleCancel = useCallback(() => {
    cancelRequestedRef.current = true;
    controllersRef.current.forEach((controller) => controller.abort());
    controllersRef.current = [];
    setStatusMessage("Varredura interrompida pelo usuário.");
    setIsScanning(false);
  }, []);

  const handleScan = useCallback(async () => {
    try {
      setStatusMessage(null);
      const ports = parsePorts(portsInput);
      if (ports.length === 0) {
        throw new Error("Informe ao menos uma porta para varredura.");
      }
      const targets = buildTargetList(startIp, endIp);
      if (targets.length === 0) {
        throw new Error("Nenhum IP encontrado dentro do intervalo.");
      }

      cancelRequestedRef.current = false;
      setProgress({ current: 0, total: targets.length });
      setResults([]);
      setIsScanning(true);

      const queue = [...targets];

      const workers = new Array(Math.min(concurrency, queue.length))
        .fill(0)
        .map(async () => {
          while (queue.length > 0 && !cancelRequestedRef.current) {
            const ip = queue.shift();
            if (!ip) {
              return;
            }
            try {
              const hostResult = await scanHost(ip, ports);
              setResults((prev) => [...prev, hostResult]);
            } catch (error) {
              const failedHost: HostResult = {
                ip,
                responded: false,
                ports: ports.map((port) => ({
                  port,
                  protocol: protocolForPort(port),
                  status: "error",
                  errorMessage: (error as Error)?.message ?? "Falha desconhecida",
                })),
              };
              setResults((prev) => [...prev, failedHost]);
            } finally {
              setProgress((prev) => ({
                current: prev.current + 1,
                total: prev.total,
              }));
            }
          }
        });

      await Promise.all(workers);

      if (!cancelRequestedRef.current) {
        setStatusMessage("Varredura concluída.");
      }
    } catch (error) {
      setStatusMessage((error as Error)?.message ?? "Falha desconhecida.");
    } finally {
      controllersRef.current.forEach((controller) => controller.abort());
      controllersRef.current = [];
      setIsScanning(false);
      cancelRequestedRef.current = false;
    }
  }, [concurrency, endIp, portsInput, scanHost, startIp]);

  const handleDownload = useCallback(() => {
    if (results.length === 0) {
      return;
    }
    const header = "IP,Porta,Protocolo,Status,Latência(ms),Mensagem";
    const lines = results.flatMap((host) =>
      host.ports.map((port) =>
        [
          host.ip,
          port.port,
          port.protocol.toUpperCase(),
          port.status.toUpperCase(),
          port.latency ?? "",
          port.errorMessage ? port.errorMessage.replace(/[\r\n]+/g, " ") : "",
        ].join(","),
      ),
    );
    const csvContent = [header, ...lines].join("\n");
    const blob = new Blob([csvContent], {
      type: "text/csv;charset=utf-8;",
    });
    const url = window.URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.setAttribute("download", `lanscope-${Date.now()}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    window.URL.revokeObjectURL(url);
  }, [results]);

  const percent = useMemo(() => {
    if (progress.total === 0) {
      return 0;
    }
    return Math.round((progress.current / progress.total) * 100);
  }, [progress]);

  return (
    <div className="min-h-screen bg-zinc-950 pb-24 text-zinc-100">
      <header className="border-b border-zinc-800 bg-zinc-950/80 backdrop-blur">
        <div className="mx-auto flex max-w-6xl flex-col gap-2 px-6 py-8 md:flex-row md:items-center md:justify-between">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight text-white">
              LanScope
            </h1>
            <p className="text-sm text-zinc-400">
              Scanner de rede local executado direto do navegador. Detecte hosts
              ativos e portas críticas em segundos.
            </p>
          </div>
          <div className="flex items-center gap-2 text-xs text-zinc-400">
            <span>Limite por varredura: {MAX_TARGETS} IPs</span>
            <span>|</span>
            <span>Timeout padrão: {timeoutMs} ms</span>
          </div>
        </div>
      </header>

      <main className="mx-auto mt-8 flex max-w-6xl flex-col gap-8 px-6">
        <section className="grid gap-6 rounded-2xl border border-zinc-800 bg-zinc-900/70 p-6 md:grid-cols-2">
          <div className="space-y-4">
            <label className="block text-sm font-semibold text-zinc-300">
              Intervalo de IP inicial
            </label>
            <input
              value={startIp}
              onChange={(event) => setStartIp(event.target.value)}
              placeholder="192.168.0.1"
              className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-white placeholder:text-zinc-500 focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
            />
            <label className="block text-sm font-semibold text-zinc-300">
              Intervalo de IP final
            </label>
            <input
              value={endIp}
              onChange={(event) => setEndIp(event.target.value)}
              placeholder="192.168.0.254"
              className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-white placeholder:text-zinc-500 focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
            />
          </div>
          <div className="flex flex-col gap-4">
            <label className="text-sm font-semibold text-zinc-300">
              Portas a testar
            </label>
            <textarea
              value={portsInput}
              onChange={(event) => setPortsInput(event.target.value)}
              rows={3}
              placeholder="80,443,3389,445,22"
              className="h-full w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-white placeholder:text-zinc-500 focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
            />
            <div className="flex flex-wrap gap-2">
              {Object.entries(COMMON_PORT_PROFILES).map(([label, ports]) => (
                <button
                  key={label}
                  type="button"
                  onClick={() => setPortsInput(ports.join(","))}
                  className="rounded-full border border-zinc-700 px-3 py-1 text-xs text-zinc-300 transition hover:border-emerald-500 hover:text-emerald-400"
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        </section>

        <section className="grid gap-6 rounded-2xl border border-zinc-800 bg-zinc-900/70 p-6 md:grid-cols-3">
          <div className="flex flex-col gap-2">
            <label className="text-sm font-semibold text-zinc-300">
              Timeout por porta (ms)
            </label>
            <input
              type="number"
              min={200}
              step={100}
              value={timeoutMs}
              onChange={(event) => setTimeoutMs(Number(event.target.value))}
              className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-white focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
            />
          </div>
          <div className="flex flex-col gap-2">
            <label className="text-sm font-semibold text-zinc-300">
              Conexões simultâneas
            </label>
            <input
              type="number"
              min={1}
              max={128}
              value={concurrency}
              onChange={(event) => setConcurrency(Number(event.target.value))}
              className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-white focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
            />
          </div>
          <div className="flex items-end justify-end gap-3">
            <button
              type="button"
              disabled={isScanning}
              onClick={handleScan}
              className="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-semibold text-emerald-950 transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:bg-emerald-800/60 disabled:text-emerald-200"
            >
              Iniciar varredura
            </button>
            <button
              type="button"
              onClick={handleCancel}
              disabled={!isScanning}
              className="rounded-lg border border-zinc-600 px-4 py-2 text-sm font-semibold text-zinc-300 transition hover:border-red-400 hover:text-red-300 disabled:cursor-not-allowed disabled:border-zinc-700 disabled:text-zinc-600"
            >
              Cancelar
            </button>
          </div>
        </section>

        {progress.total > 0 && (
          <section className="rounded-2xl border border-zinc-800 bg-zinc-900/70 p-6">
            <div className="flex items-center justify-between">
              <p className="text-sm text-zinc-400">
                Processados {progress.current} de {progress.total} alvos
              </p>
              <span className="text-sm font-semibold text-emerald-400">
                {percent}%
              </span>
            </div>
            <div className="mt-3 h-2 w-full rounded-full bg-zinc-800">
              <div
                className="h-2 rounded-full bg-emerald-500 transition-all duration-300"
                style={{ width: `${percent}%` }}
              />
            </div>
            {statusMessage && (
              <p className="mt-3 text-sm text-zinc-400">{statusMessage}</p>
            )}
          </section>
        )}

        {results.length > 0 && (
          <section className="space-y-4 rounded-2xl border border-zinc-800 bg-zinc-900/70 p-6">
            <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
              <div>
                <h2 className="text-xl font-semibold text-white">
                  Resultados da varredura
                </h2>
                <p className="text-sm text-zinc-400">
                  {stats.responsive} hosts responsivos · {stats.totalHosts} analisados
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={handleDownload}
                  className="rounded-lg border border-emerald-500 px-4 py-2 text-sm font-semibold text-emerald-400 transition hover:bg-emerald-500/10"
                >
                  Exportar CSV
                </button>
                <button
                  type="button"
                  onClick={() => setResults([])}
                  className="rounded-lg border border-zinc-700 px-4 py-2 text-sm font-semibold text-zinc-300 transition hover:border-red-400 hover:text-red-300"
                >
                  Limpar resultados
                </button>
              </div>
            </div>

            <div className="overflow-hidden rounded-xl border border-zinc-800">
              <table className="min-w-full divide-y divide-zinc-800">
                <thead className="bg-zinc-950/80">
                  <tr className="text-left text-xs uppercase tracking-wide text-zinc-500">
                    <th className="px-4 py-3 font-semibold">IP</th>
                    <th className="px-4 py-3 font-semibold">Status</th>
                    <th className="px-4 py-3 font-semibold">Portas</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-800 bg-zinc-900/60">
                  {orderedResults.map((host) => {
                    const hostStatus = host.ports.some(
                      (port) => port.status === "open",
                    )
                      ? "Host ativo"
                      : host.ports.every((port) => port.status === "timeout")
                        ? "Sem resposta"
                        : "Sem serviços detectados";
                    return (
                      <tr key={host.ip} className="text-sm text-zinc-300">
                        <td className="px-4 py-3 font-mono text-xs uppercase text-zinc-400">
                          {host.ip}
                        </td>
                        <td className="px-4 py-3">
                          <span
                            className={`rounded-full px-3 py-1 text-xs font-semibold ${
                              hostStatus === "Host ativo"
                                ? "bg-emerald-500/10 text-emerald-300"
                                : hostStatus === "Sem resposta"
                                  ? "bg-zinc-800 text-zinc-500"
                                  : "bg-amber-500/10 text-amber-300"
                            }`}
                          >
                            {hostStatus}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex flex-wrap gap-2">
                            {host.ports.map((port) => (
                              <span
                                key={`${host.ip}-${port.port}-${port.protocol}`}
                                className={`rounded-full px-3 py-1 text-xs font-semibold ${
                                  port.status === "open"
                                    ? "bg-emerald-500/10 text-emerald-300"
                                    : port.status === "timeout"
                                      ? "bg-zinc-800 text-zinc-400"
                                      : port.status === "closed"
                                        ? "bg-zinc-900 text-zinc-500"
                                        : "bg-red-500/10 text-red-300"
                                }`}
                                title={
                                  port.latency
                                    ? `Latência ~${port.latency}ms`
                                    : port.errorMessage ?? undefined
                                }
                              >
                                {port.protocol.toUpperCase()} • {port.port}
                              </span>
                            ))}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
