import { useEffect, useMemo, useState } from 'react';
import { ConsoleShell } from './shell/ConsoleShell.js';
import { CommandBar } from './command-bar/CommandBar.js';
import { LayerRail } from './layer-rail/LayerRail.js';
import { EntityPanel } from './entity-panel/EntityPanel.js';
import { Timeline } from './timeline/Timeline.js';
import { MapLibreCanvas } from './maplibre/MapLibreCanvas.js';
import { LayerRegistry } from './registry/LayerRegistry.js';
import { registerDefaults } from './registry/defaults.js';
import { fetchRuntimeConfig } from './transport/config.js';
import { AlertSubscriber } from './alerts/AlertSubscriber.js';
import type { RuntimeConfig } from '@osint/shared';

// 2D mirror at /2d. Same LayerRegistry, MapLibre instead of Cesium. Used
// when the operator wants Mercator measurement, dense clustering, or has
// WebGL2 (not WebGL1) — and as a defence-grade resilience path when the
// 3D pipeline is offline.
export function App2D(): JSX.Element {
  const registry = useMemo(() => {
    const r = new LayerRegistry();
    registerDefaults(r);
    return r;
  }, []);
  const [config, setConfig] = useState<RuntimeConfig | null>(null);

  useEffect(() => {
    fetchRuntimeConfig().then(setConfig).catch(() => undefined);
  }, []);

  return (
    <>
      <AlertSubscriber />
      <ConsoleShell
        top={<CommandBar viewer={null} classification={config?.classification ?? 'UNCLAS'} />}
        left={<LayerRail registry={registry} viewer={null} />}
        globe={<MapLibreCanvas registry={registry} />}
        right={<EntityPanel />}
        bottom={<Timeline />}
      />
    </>
  );
}
