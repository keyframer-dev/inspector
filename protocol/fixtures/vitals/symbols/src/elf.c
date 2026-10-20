/* Motion Vitals symbol fixture: freestanding code for an ELF (no libc), linked with lld. */
static volatile int sink;

int scroll_offset(int y) {
  int v = y / 2;
  sink = v;
  return v;
}

int list_frame(int rows) {
  int total = 0;
  for (int i = 0; i < rows; i++) {
    total += scroll_offset(i * 8);
  }
  return total;
}

void _start(void) {
  sink = list_frame(3);
  for (;;) {
  }
}
