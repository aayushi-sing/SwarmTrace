import { useCallback, useEffect, useMemo } from 'react'
import { ReactFlow, Background, Controls, MiniMap, useNodesState, useEdgesState, useNodesInitialized, useReactFlow, useStore } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import SpanNode from './SpanNode'
import { layoutSpans } from '../traceUtils'
import { useTheme } from './ThemeProvider'

const nodeTypes = { spanNode: SpanNode }
function FitHierarchy({ signature }) {
  const initialized = useNodesInitialized()
  const width = useStore(state => state.width)
  const height = useStore(state => state.height)
  const { fitView } = useReactFlow()
  useEffect(() => {
    if (!initialized) return
    const frame = requestAnimationFrame(() => fitView({ padding: .18 }))
    return () => cancelAnimationFrame(frame)
  }, [initialized, signature, fitView, width, height])
  return null
}
export default function SpanTree({ spans, selectedSpanId, onNodeClick }) {
  const { theme } = useTheme()
  const layout = useMemo(() => layoutSpans(spans), [spans])
  const [nodes, setNodes, onNodesChange] = useNodesState(layout.nodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState(layout.edges)
  useEffect(() => {
    setNodes(layout.nodes)
    setEdges(layout.edges)
  }, [layout, setNodes, setEdges])
  useEffect(() => {
    setNodes(previous => previous.map(node => ({ ...node, selected: node.id === selectedSpanId })))
  }, [layout, selectedSpanId, setNodes])
  const handleNodeClick = useCallback((_, node) => onNodeClick?.(node.data), [onNodeClick])
  return <div className="execution-canvas" aria-label="Interactive execution hierarchy">
    <ReactFlow nodes={nodes} edges={edges} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onNodeClick={handleNodeClick} nodeTypes={nodeTypes} fitView fitViewOptions={{ padding: .22 }} minZoom={.15} maxZoom={1.8} colorMode={theme} proOptions={{ hideAttribution: true }}>
      <FitHierarchy signature={`${layout.nodes.map(node => node.id).join(',')}:${layout.edges.map(edge => edge.id).join(',')}`}/>
      <Background color="var(--border)" gap={22} size={1}/>
      <Controls showInteractive={false}/>
      <MiniMap nodeColor="var(--text-muted)" maskColor="var(--bg-primary)" pannable zoomable/>
    </ReactFlow>
  </div>
}
