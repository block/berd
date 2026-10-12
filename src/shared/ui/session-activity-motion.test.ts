import { describe, expect, it } from "vitest";
import {
  activityPose,
  SESSION_ACTIVITY_LOOP_MS,
  SESSION_ACTIVITY_STYLES,
  SessionActivityMotion,
} from "./session-activity-motion";

describe("session activity motion", () => {
  it.each(
    SESSION_ACTIVITY_STYLES,
  )("%s keeps four separate dots in the slot and never pauses", (style) => {
    const loop = SESSION_ACTIVITY_LOOP_MS[style];
    const pose = (time: number) => activityPose(style, time);
    for (let time = 0; time < loop; time += 10) {
      const dots = pose(time);
      const next = pose(time + 10);
      expect(dots).toHaveLength(4);
      expect(
        Math.max(
          ...dots.map((dot, i) =>
            Math.hypot(next[i].x - dot.x, next[i].y - dot.y),
          ),
        ),
      ).toBeGreaterThan(0.01);
      dots.forEach((dot, i) => {
        expect(Math.abs(dot.x) + dot.radius).toBeLessThan(10);
        expect(Math.abs(dot.y) + dot.radius).toBeLessThan(10);
        dots.slice(i + 1).forEach((other) => {
          expect(Math.hypot(dot.x - other.x, dot.y - other.y)).toBeGreaterThan(
            dot.radius + other.radius,
          );
        });
      });
    }
    pose(loop).forEach((dot, i) => {
      expect(dot.x).toBeCloseTo(pose(0)[i].x);
      expect(dot.y).toBeCloseTo(pose(0)[i].y);
    });
  });

  it.each([
    0, 113, 790, 3000, 4890, 5900,
  ])("gathers from the current pose at phase %i, including interrupted restarts", (phase) => {
    const model = new SessionActivityMotion("working", true);
    model.step(phase);
    const working = structuredClone(model.pose);
    model.setState("unread", true);
    expect(model.pose).toEqual(working);
    model.step(150);
    const gathering = structuredClone(model.pose);
    model.setState("working", true);
    expect(model.pose).toEqual(gathering);
    model.step(400);
    expect(model.moving).toBe(true);
    model.setState("unread", true);
    model.step(600);
    expect(model.pose).toEqual(
      Array.from({ length: 4 }, () => ({ x: 0, y: 0, radius: 3.5 })),
    );
    expect(model.moving).toBe(false);
  });

  it("does not replay completion for initially unread sessions", () => {
    const model = new SessionActivityMotion("unread", true);
    expect(model.moving).toBe(false);
    expect(
      model.pose.every(
        (dot) => dot.x === 0 && dot.y === 0 && dot.radius === 3.5,
      ),
    ).toBe(true);
  });

  it("never manufactures unread when work stops or the reply is read during gathering", () => {
    const model = new SessionActivityMotion("working", true);
    model.step(300);
    model.setState("idle", true);
    expect(model.pose.every((dot) => dot.radius === 0)).toBe(true);
    expect(model.moving).toBe(false);
    model.setState("working", true);
    model.setState("unread", true);
    model.step(200);
    model.setState("idle", true);
    expect(model.pose.every((dot) => dot.radius === 0)).toBe(true);
    expect(model.moving).toBe(false);
  });

  it("defaults to the distant bird, evenly spaced", () => {
    const model = new SessionActivityMotion("working", true);
    expect(model.pose).toEqual(activityPose("bird", 0));
    const xs = activityPose("bird", 0).map((dot) => dot.x);
    expect(xs[2] - xs[1]).toBeCloseTo(5);
  });

  it("moves from the current pose into a newly chosen style", () => {
    const model = new SessionActivityMotion("working", true, "bird");
    model.step(700);
    const painted = structuredClone(model.pose);
    model.setStyle("beak");
    expect(model.pose).toEqual(painted);
    model.step(400);
    expect(model.moving).toBe(true);
    model.step(100);
    const beakDots = model.pose;
    expect(beakDots.every((dot) => dot.radius === 1.4)).toBe(true);
  });

  it.each(
    SESSION_ACTIVITY_STYLES,
  )("%s still shows four distinct dots with motion off", (style) => {
    const model = new SessionActivityMotion("working", false, style);
    expect(new Set(model.pose.map((dot) => `${dot.x},${dot.y}`)).size).toBe(4);
  });

  it("switches instantly between four static dots and one dot when motion is off", () => {
    const model = new SessionActivityMotion("working", false);
    expect(new Set(model.pose.map((dot) => `${dot.x},${dot.y}`)).size).toBe(4);
    expect(model.moving).toBe(false);
    model.setState("unread", false);
    expect(
      model.pose.every(
        (dot) => dot.x === 0 && dot.y === 0 && dot.radius === 3.5,
      ),
    ).toBe(true);
    model.setState("working", true);
    model.step(100);
    model.setState("unread", true);
    model.step(100);
    model.setState("unread", false);
    expect(model.pose.every((dot) => dot.radius === 3.5)).toBe(true);
    expect(model.moving).toBe(false);
  });
});
