// A sysctl string on Apple platforms (hw.machine on an iPhone, hw.model on a Mac), read through dart:ffi
// from the C library the app already links: no native code ships with the package, and no plugin.

import 'dart:convert';
import 'dart:ffi';

typedef _SysctlByNameC = Int32 Function(Pointer<Uint8>, Pointer<Uint8>, Pointer<Size>, Pointer<Void>, Size);
typedef _SysctlByName = int Function(Pointer<Uint8>, Pointer<Uint8>, Pointer<Size>, Pointer<Void>, int);
typedef _MallocC = Pointer<Void> Function(Size);
typedef _Malloc = Pointer<Void> Function(int);
typedef _FreeC = Void Function(Pointer<Void>);
typedef _Free = void Function(Pointer<Void>);

/// `sysctlbyname(name)` as a string, or null when it is not there (or anything else goes wrong).
String? darwinSysctl(String name) {
  try {
    final libc = DynamicLibrary.process();
    final sysctlbyname = libc.lookupFunction<_SysctlByNameC, _SysctlByName>('sysctlbyname');
    final malloc = libc.lookupFunction<_MallocC, _Malloc>('malloc');
    final free = libc.lookupFunction<_FreeC, _Free>('free');
    const capacity = 256;
    final key = utf8.encode(name);
    final keyPtr = malloc(key.length + 1).cast<Uint8>();
    final buffer = malloc(capacity).cast<Uint8>();
    final length = malloc(sizeOf<Size>()).cast<Size>();
    try {
      keyPtr.asTypedList(key.length + 1)
        ..setAll(0, key)
        ..[key.length] = 0;
      length.value = capacity;
      if (sysctlbyname(keyPtr, buffer, length, nullptr, 0) != 0) return null;
      final bytes = buffer.asTypedList(length.value < capacity ? length.value : capacity);
      final end = bytes.indexOf(0);
      return utf8.decode(end < 0 ? bytes : bytes.sublist(0, end), allowMalformed: true);
    } finally {
      free(keyPtr.cast());
      free(buffer.cast());
      free(length.cast());
    }
  } catch (_) {
    return null;
  }
}
