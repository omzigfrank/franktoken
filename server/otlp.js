import protobuf from 'protobufjs'
import { gunzipSync } from 'node:zlib'

const schema = String.raw`
syntax = "proto3";
package franktoken.otlp;

message AnyValue {
  oneof value {
    string string_value = 1;
    bool bool_value = 2;
    int64 int_value = 3;
    double double_value = 4;
    ArrayValue array_value = 5;
    KeyValueList kvlist_value = 6;
    bytes bytes_value = 7;
  }
}
message ArrayValue { repeated AnyValue values = 1; }
message KeyValueList { repeated KeyValue values = 1; }
message KeyValue { string key = 1; AnyValue value = 2; }
message Resource { repeated KeyValue attributes = 1; uint32 dropped_attributes_count = 2; }
message InstrumentationScope { string name = 1; string version = 2; repeated KeyValue attributes = 3; uint32 dropped_attributes_count = 4; }

message SpanEvent { fixed64 time_unix_nano = 1; string name = 2; repeated KeyValue attributes = 3; uint32 dropped_attributes_count = 4; }
message Span {
  bytes trace_id = 1; bytes span_id = 2; string trace_state = 3; bytes parent_span_id = 4;
  string name = 5; int32 kind = 6; fixed64 start_time_unix_nano = 7; fixed64 end_time_unix_nano = 8;
  repeated KeyValue attributes = 9; uint32 dropped_attributes_count = 10; repeated SpanEvent events = 11;
}
message ScopeSpans { InstrumentationScope scope = 1; repeated Span spans = 2; string schema_url = 3; }
message ResourceSpans { Resource resource = 1; repeated ScopeSpans scope_spans = 2; string schema_url = 3; }
message ExportTraceServiceRequest { repeated ResourceSpans resource_spans = 1; }

message LogRecord {
  fixed64 time_unix_nano = 1; int32 severity_number = 2; string severity_text = 3; AnyValue body = 5;
  repeated KeyValue attributes = 6; uint32 dropped_attributes_count = 7; fixed64 observed_time_unix_nano = 11;
  bytes trace_id = 9; bytes span_id = 10;
}
message ScopeLogs { InstrumentationScope scope = 1; repeated LogRecord log_records = 2; string schema_url = 3; }
message ResourceLogs { Resource resource = 1; repeated ScopeLogs scope_logs = 2; string schema_url = 3; }
message ExportLogsServiceRequest { repeated ResourceLogs resource_logs = 1; }

message NumberDataPoint {
  repeated KeyValue attributes = 7; fixed64 start_time_unix_nano = 2; fixed64 time_unix_nano = 3;
  oneof value { double as_double = 4; sfixed64 as_int = 6; }
  uint32 flags = 8;
}
message Gauge { repeated NumberDataPoint data_points = 1; }
message Sum { repeated NumberDataPoint data_points = 1; int32 aggregation_temporality = 2; bool is_monotonic = 3; }
message Metric { string name = 1; string description = 2; string unit = 3; oneof data { Gauge gauge = 5; Sum sum = 7; } }
message ScopeMetrics { InstrumentationScope scope = 1; repeated Metric metrics = 2; string schema_url = 3; }
message ResourceMetrics { Resource resource = 1; repeated ScopeMetrics scope_metrics = 2; string schema_url = 3; }
message ExportMetricsServiceRequest { repeated ResourceMetrics resource_metrics = 1; }
`

const root = protobuf.parse(schema, { keepCase: false }).root
const types = {
  traces: root.lookupType('franktoken.otlp.ExportTraceServiceRequest'),
  logs: root.lookupType('franktoken.otlp.ExportLogsServiceRequest'),
  metrics: root.lookupType('franktoken.otlp.ExportMetricsServiceRequest')
}

function pick(object, ...keys) {
  for (const key of keys) if (object?.[key] != null) return object[key]
  return undefined
}

function array(object, ...keys) {
  const value = pick(object, ...keys)
  return Array.isArray(value) ? value : []
}

function valueOf(value) {
  if (!value) return null
  const scalar = pick(value, 'stringValue', 'string_value', 'boolValue', 'bool_value', 'intValue', 'int_value', 'doubleValue', 'double_value')
  if (scalar != null) return typeof scalar === 'object' && scalar.toString ? scalar.toString() : scalar
  const bytes = pick(value, 'bytesValue', 'bytes_value')
  if (bytes != null) return bytes
  const list = pick(value, 'arrayValue', 'array_value')
  if (list) return array(list, 'values').map(valueOf)
  const map = pick(value, 'kvlistValue', 'kvlist_value')
  if (map) return attributes(array(map, 'values'))
  return null
}

function attributes(items) {
  return Object.fromEntries(items.map((item) => [item.key, valueOf(item.value)]))
}

function millis(nanos) {
  if (nanos == null) return Date.now()
  try { return Number(BigInt(String(nanos)) / 1_000_000n) } catch { return Date.now() }
}

function byteId(value) {
  if (!value) return null
  if (typeof value === 'string') return value
  return Buffer.from(value).toString('hex')
}

function decodedObject(type, payload) {
  const message = type.decode(payload)
  return type.toObject(message, { longs: String, bytes: Buffer, enums: String, defaults: false })
}

function flattenTraces(document) {
  const output = []
  for (const resourceSpans of array(document, 'resourceSpans', 'resource_spans')) {
    const resource = attributes(array(resourceSpans.resource, 'attributes'))
    for (const scopeSpans of array(resourceSpans, 'scopeSpans', 'scope_spans')) {
      const scope = scopeSpans.scope || {}
      for (const span of array(scopeSpans, 'spans')) {
        output.push({
          signal: 'traces',
          resource,
          scope: { name: scope.name || null, version: scope.version || null },
          name: span.name,
          traceId: byteId(pick(span, 'traceId', 'trace_id')),
          spanId: byteId(pick(span, 'spanId', 'span_id')),
          parentSpanId: byteId(pick(span, 'parentSpanId', 'parent_span_id')),
          startedAt: millis(pick(span, 'startTimeUnixNano', 'start_time_unix_nano')),
          endedAt: millis(pick(span, 'endTimeUnixNano', 'end_time_unix_nano')),
          attributes: attributes(array(span, 'attributes')),
          events: array(span, 'events').map((event) => ({ name: event.name, timestamp: millis(pick(event, 'timeUnixNano', 'time_unix_nano')), attributes: attributes(array(event, 'attributes')) }))
        })
      }
    }
  }
  return output
}

function flattenLogs(document) {
  const output = []
  for (const resourceLogs of array(document, 'resourceLogs', 'resource_logs')) {
    const resource = attributes(array(resourceLogs.resource, 'attributes'))
    for (const scopeLogs of array(resourceLogs, 'scopeLogs', 'scope_logs')) {
      const scope = scopeLogs.scope || {}
      for (const record of array(scopeLogs, 'logRecords', 'log_records')) {
        output.push({
          signal: 'logs', resource, scope: { name: scope.name || null, version: scope.version || null },
          name: record.eventName || record.name || null,
          timestamp: millis(pick(record, 'timeUnixNano', 'time_unix_nano', 'observedTimeUnixNano', 'observed_time_unix_nano')),
          traceId: byteId(pick(record, 'traceId', 'trace_id')),
          spanId: byteId(pick(record, 'spanId', 'span_id')),
          severity: pick(record, 'severityText', 'severity_text') || null,
          body: valueOf(record.body), attributes: attributes(array(record, 'attributes'))
        })
      }
    }
  }
  return output
}

function flattenMetrics(document) {
  const output = []
  for (const resourceMetrics of array(document, 'resourceMetrics', 'resource_metrics')) {
    const resource = attributes(array(resourceMetrics.resource, 'attributes'))
    for (const scopeMetrics of array(resourceMetrics, 'scopeMetrics', 'scope_metrics')) {
      const scope = scopeMetrics.scope || {}
      for (const metric of array(scopeMetrics, 'metrics')) {
        const data = metric.sum || metric.gauge || {}
        for (const point of array(data, 'dataPoints', 'data_points')) {
          output.push({
            signal: 'metrics', resource, scope: { name: scope.name || null, version: scope.version || null },
            name: metric.name, description: metric.description || null, unit: metric.unit || null,
            timestamp: millis(pick(point, 'timeUnixNano', 'time_unix_nano')),
            value: Number(pick(point, 'asDouble', 'as_double', 'asInt', 'as_int') || 0),
            attributes: attributes(array(point, 'attributes'))
          })
        }
      }
    }
  }
  return output
}

export function decodeOtlp(buffer, signal, headers = {}) {
  let payload = buffer
  if (/gzip/i.test(headers['content-encoding'] || '')) payload = gunzipSync(payload)
  const contentType = String(headers['content-type'] || '').toLowerCase()
  const document = contentType.includes('json')
    ? JSON.parse(payload.toString('utf8'))
    : decodedObject(types[signal], payload)
  if (signal === 'traces') return flattenTraces(document)
  if (signal === 'logs') return flattenLogs(document)
  return flattenMetrics(document)
}

export const otlpInternals = { valueOf, attributes, millis, types }
