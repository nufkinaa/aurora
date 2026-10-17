// The Fabric specs (src/specs/*NativeComponent.ts) for the logic tests: the codegen
// babel plugin turns a spec into a native view-config registration, which plain node
// cannot load. Here a native component is a host string and every command a no-op.
const commands = new Proxy({}, {get: () => () => {}});
module.exports = {__esModule: true, default: 'AuroraNative', Commands: commands};
