/* Motion Vitals symbol fixture: a tiny program with a few functions on known lines. */
static volatile int sink;

int spring_step(int x) {
  int v = x * 3;
  sink = v;
  return v + 1;
}

int card_expand(int n) {
  int total = 0;
  for (int i = 0; i < n; i++) {
    total += spring_step(i);
  }
  return total;
}

int frame_tick(int frame);

int main(void) {
  return card_expand(4) + frame_tick(2);
}
