// Motion Vitals symbol fixture: C++ names, to check demangling.
namespace motion {
struct Spring {
  int stiffness;
  int step(int t) const { return stiffness * t; }
};

int interpolate(int from, int to, int t) {
  Spring s{from};
  return s.step(t) + to;
}
}  // namespace motion

extern "C" int frame_tick(int frame) {
  return motion::interpolate(frame, 2, 3);
}
