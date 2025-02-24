import * as THREE from "three";
import RAPIER from "@dimforge/rapier3d-compat";
import { Pose } from "@mediapipe/pose";
import tmi from "tmi.js";

interface PoseLandmark {
  x: number;
  y: number;
  z: number;
  visibility?: number;
}

class GoalkeeperGame {
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private renderer: THREE.WebGLRenderer;
  private rapierWorld!: RAPIER.World;
  private pose: Pose;
  private player: THREE.Group;
  private goal: THREE.Group;
  private balls: Array<{
    mesh: THREE.Mesh;
    body: RAPIER.RigidBody;
    collider: RAPIER.Collider;
  }> = [];
  private lastShot: number = 0;
  private readonly SHOT_INTERVAL = 2000;
  private landmarkPoints: THREE.Points | null = null;
  private leftHandCollider: RAPIER.Collider | null = null;
  private rightHandCollider: RAPIER.Collider | null = null;
  private leftHandMesh: THREE.Mesh;
  private rightHandMesh: THREE.Mesh;
  private twitchClient: tmi.Client;

  // New properties for easier saves
  private handColliderSize = 1.5; // Increased from 1.2
  private ballImpulseMagnitude = 3; // Reduced initial ball impulse

  // Add new property
  private savesCount: number = 0;
  private savesCounter: HTMLElement | null = null;

  // Add new properties
  private goalsCount: number = 0;
  private goalsCounter: HTMLElement | null = null;
  private readonly GOAL_BOUNDS = {
    minX: -7, // Half goal width
    maxX: 7,
    minY: 0,
    maxY: 7, // Goal height
    z: 0, // Goal position on z-axis
  };

  constructor() {
    this.initializeThreeJS();
    this.initializeTwitchChat();
    this.initializeGame();
    this.savesCounter = document.getElementById("saves-counter");
    this.goalsCounter = document.getElementById("goals-counter");
  }

  private async initializeGame() {
    try {
      await this.initializePhysics();
      await this.createGoal();
      await this.createPlayer();
      this.initializePoseDetection();
      this.animate();
      window.addEventListener("resize", () => this.onWindowResize());
    } catch (error) {
      console.error("Error initializing game:", error);
    }
  }

  private async initializePhysics() {
    await RAPIER.init();
    this.rapierWorld = new RAPIER.World({
      x: 0.0,
      y: -0.01,
      z: 0.0,
    });
  }

  private initializeThreeJS() {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x87ceeb);

    this.camera = new THREE.PerspectiveCamera(
      75,
      window.innerWidth / window.innerHeight,
      0.1,
      1000
    );

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    document.body.appendChild(this.renderer.domElement);

    this.camera.position.set(0, 1.7, 11);
    this.camera.lookAt(0, 1.7, 0);

    const groundGeometry = new THREE.PlaneGeometry(20, 20);
    const groundMaterial = new THREE.MeshStandardMaterial({
      color: 0x3a8c3a,
      roughness: 0.8,
      metalness: 0.2,
    });
    const ground = new THREE.Mesh(groundGeometry, groundMaterial);
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = 0;
    ground.receiveShadow = true;
    this.scene.add(ground);

    this.addLighting();
  }

  private initializePoseDetection() {
    this.pose = new Pose({
      locateFile: (file) => {
        return `https://cdn.jsdelivr.net/npm/@mediapipe/pose/${file}`;
      },
    });

    this.pose.setOptions({
      modelComplexity: 1,
      smoothLandmarks: true,
      minDetectionConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });

    this.pose.onResults((results) => {
      if (results.poseLandmarks) {
        this.updatePlayerPosition(results.poseLandmarks);
      } else {
        console.warn("No pose landmarks detected");
      }
    });

    const video = document.querySelector("#webcam") as HTMLVideoElement;
    if (!video) {
      console.error("Webcam video element not found");
      return;
    }

    navigator.mediaDevices
      .getUserMedia({ video: true })
      .then((stream) => {
        video.srcObject = stream;
        video.onloadedmetadata = () => {
          video.play();
          this.processWebcam(video);
        };
      })
      .catch((error) => {
        console.error("Error accessing webcam:", error);
      });
  }

  private async processWebcam(video: HTMLVideoElement) {
    while (video.readyState === 4) {
      try {
        await this.pose.send({ image: video });
      } catch (error) {
        console.error("Error processing webcam frame:", error);
      }
      await new Promise(requestAnimationFrame);
    }
  }

  private createGoal() {
    const goalWidth = 14;
    const goalHeight = 7;

    this.goal = new THREE.Group();

    const poleGeometry = new THREE.CylinderGeometry(0.15, 0.15, goalHeight);
    const poleMaterial = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.2,
      metalness: 0.7,
    });

    const leftPole = new THREE.Mesh(poleGeometry, poleMaterial);
    const rightPole = new THREE.Mesh(poleGeometry, poleMaterial);
    leftPole.position.set(-goalWidth / 2, goalHeight / 2, 0);
    rightPole.position.set(goalWidth / 2, goalHeight / 2, 0);
    leftPole.castShadow = true;
    rightPole.castShadow = true;

    const crossbarGeometry = new THREE.CylinderGeometry(0.15, 0.15, goalWidth);
    const crossbar = new THREE.Mesh(crossbarGeometry, poleMaterial);
    crossbar.rotation.z = Math.PI / 2;
    crossbar.position.set(0, goalHeight, 0);
    crossbar.castShadow = true;

    const netGeometry = new THREE.BoxGeometry(goalWidth + 0.3, goalHeight, 1);
    const netMaterial = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      opacity: 0.3,
      transparent: true,
      wireframe: true,
      wireframeLinewidth: 2,
    });
    const net = new THREE.Mesh(netGeometry, netMaterial);
    net.position.set(0, goalHeight / 2, -0.5);

    this.goal.add(leftPole, rightPole, crossbar, net);
    this.scene.add(this.goal);

    const leftPoleBody = this.rapierWorld.createRigidBody(
      RAPIER.RigidBodyDesc.fixed().setTranslation(
        -goalWidth / 2,
        goalHeight / 2,
        0
      )
    );

    const rightPoleBody = this.rapierWorld.createRigidBody(
      RAPIER.RigidBodyDesc.fixed().setTranslation(
        goalWidth / 2,
        goalHeight / 2,
        0
      )
    );

    const crossbarBody = this.rapierWorld.createRigidBody(
      RAPIER.RigidBodyDesc.fixed()
        .setTranslation(0, goalHeight, 0)
        .setRotation(new RAPIER.Quaternion(0, 0, Math.PI / 2, 1))
    );

    this.rapierWorld.createCollider(
      RAPIER.ColliderDesc.cylinder(goalHeight / 2, 0.15),
      leftPoleBody
    );

    this.rapierWorld.createCollider(
      RAPIER.ColliderDesc.cylinder(goalHeight / 2, 0.15),
      rightPoleBody
    );

    this.rapierWorld.createCollider(
      RAPIER.ColliderDesc.cylinder(goalWidth / 2, 0.15),
      crossbarBody
    );
  }

  private createPlayer() {
    this.player = new THREE.Group();

    const bodyMaterial = new THREE.MeshPhongMaterial({ color: 0x00ff00 });

    // Make hands much larger for better collision detection
    const handGeometry = new THREE.SphereGeometry(1.2); // Increased visual size
    this.leftHandMesh = new THREE.Mesh(handGeometry, bodyMaterial);
    this.rightHandMesh = new THREE.Mesh(handGeometry, bodyMaterial);
    this.leftHandMesh.position.set(-0.5, 1.6, 0);
    this.rightHandMesh.position.set(0.5, 1.6, 0);

    this.player.add(this.leftHandMesh, this.rightHandMesh);
    this.scene.add(this.player);

    const playerBody = this.rapierWorld.createRigidBody(
      RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(0, 0.75, 0)
    );

    // Modify the hand colliders
    this.leftHandCollider = this.rapierWorld.createCollider(
      RAPIER.ColliderDesc.ball(this.handColliderSize)
        .setRestitution(1.5)
        .setFriction(0.5)
        .setSensor(false) // Changed to false for physical collisions
        .setActiveEvents(
          RAPIER.ActiveEvents.COLLISION_EVENTS |
            RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS |
            RAPIER.ActiveEvents.INTERSECTION_EVENTS
        ),
      playerBody
    );

    this.rightHandCollider = this.rapierWorld.createCollider(
      RAPIER.ColliderDesc.ball(this.handColliderSize)
        .setRestitution(1.5)
        .setFriction(0.5)
        .setSensor(false) // Changed to false for physical collisions
        .setActiveEvents(
          RAPIER.ActiveEvents.COLLISION_EVENTS |
            RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS |
            RAPIER.ActiveEvents.INTERSECTION_EVENTS
        ),
      playerBody
    );

    this.visualizeCollider(this.leftHandMesh, this.handColliderSize);
    this.visualizeCollider(this.rightHandMesh, this.handColliderSize);
  }

  private addLighting() {
    const ambientLight = new THREE.AmbientLight(0xffffff, 1.0);
    this.scene.add(ambientLight);

    const frontLight = new THREE.DirectionalLight(0xffffff, 1.0);
    frontLight.position.set(0, 5, 10);
    this.scene.add(frontLight);

    const topLight = new THREE.DirectionalLight(0xffffff, 0.5);
    topLight.position.set(0, 10, 0);
    this.scene.add(topLight);

    const hemisphereLight = new THREE.HemisphereLight(0xffffff, 0x444444, 1);
    this.scene.add(hemisphereLight);
  }

  private initializeTwitchChat() {
    this.twitchClient = new tmi.Client({
      channels: ["huikkakoodaa"], // Replace with your Twitch channel name
    });

    this.twitchClient.connect();

    this.twitchClient.on("message", (channel, tags, message, self) => {
      console.log(message);
      if (message.toLowerCase() === "!shoot") {
        this.shootBall();
      }
    });
  }

  private shootBall() {
    const now = Date.now();
    if (now - this.lastShot < this.SHOT_INTERVAL) {
      return;
    }
    this.lastShot = now;

    const visualSize = 0.35; // Keep small visual size
    const colliderSize = 0.8; // Increased from 0.6

    const ballGeometry = new THREE.SphereGeometry(visualSize);
    const ballMaterial = new THREE.MeshPhongMaterial({
      color: 0xff0000,
    });
    const ballMesh = new THREE.Mesh(ballGeometry, ballMaterial);

    const xPos = (Math.random() - 0.5) * 3;
    const yPos = Math.random() * 2 + 1;
    ballMesh.position.set(xPos, yPos, 10);

    const ballBody = this.rapierWorld.createRigidBody(
      new RAPIER.RigidBodyDesc(RAPIER.RigidBodyType.Dynamic).setTranslation(
        xPos,
        yPos,
        10
      )
    );

    const ballCollider = this.rapierWorld.createCollider(
      RAPIER.ColliderDesc.ball(colliderSize)
        .setRestitution(0.8)
        .setFriction(0.5)
        .setDensity(1.0),
      ballBody
    );

    const targetX = (Math.random() - 0.5) * 14;
    const targetY = Math.random() * 7;

    const force = new RAPIER.Vector3(targetX - xPos, targetY - yPos, -10);
    const length = Math.sqrt(force.x ** 2 + force.y ** 2 + force.z ** 2);
    force.x /= length;
    force.y /= length;
    force.z /= length;
    force.x *= this.ballImpulseMagnitude; // Reduced impulse magnitude
    force.y *= this.ballImpulseMagnitude;
    force.z *= this.ballImpulseMagnitude;
    ballBody.applyImpulse(force, true);

    this.balls.push({
      mesh: ballMesh,
      body: ballBody,
      collider: ballCollider,
    });
    this.scene.add(ballMesh);

    this.visualizeCollider(ballMesh, colliderSize);
  }

  private visualizeCollider(mesh: THREE.Mesh, radius: number) {
    const wireframeGeometry = new THREE.WireframeGeometry(
      new THREE.SphereGeometry(radius)
    );
    const wireframeMaterial = new THREE.LineBasicMaterial({ color: 0x0000ff });
    const wireframe = new THREE.LineSegments(
      wireframeGeometry,
      wireframeMaterial
    );
    mesh.add(wireframe);
  }

  private updatePlayerPosition(landmarks: PoseLandmark[]) {
    try {
      if (!landmarks || landmarks.length < 33) {
        console.warn("Invalid landmarks data");
        return;
      }

      const leftHand = landmarks[15];
      const rightHand = landmarks[16];

      const body = this.player;

      this.leftHandMesh.position.set(
        leftHand.x * 10 - 5,
        (1 - leftHand.y) * 4,
        0
      );

      this.rightHandMesh.position.set(
        rightHand.x * 10 - 5,
        (1 - rightHand.y) * 4,
        0
      );
    } catch (error) {
      console.error("Error updating player position:", error);
    }
  }

  private updateLandmarkPoints(landmarks: PoseLandmark[]) {
    if (!this.landmarkPoints) return;

    const positions = this.landmarkPoints.geometry.attributes.position
      .array as Float32Array;

    landmarks.forEach((landmark, index) => {
      positions[index * 3] = landmark.x * 10 - 5;
      positions[index * 3 + 1] = landmark.y * 4;
      positions[index * 3 + 2] = 0;
    });

    this.landmarkPoints.geometry.attributes.position.needsUpdate = true;
  }

  private onWindowResize() {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  }

  private animate() {
    requestAnimationFrame(() => this.animate());
    this.shootBall();

    // Debug logging of ball positions and hand positions
    this.balls.forEach((ball, index) => {
      const pos = ball.body.translation();
      console.log(`Ball ${index} position:`, pos.x, pos.y, pos.z);
    });
    console.log("Left hand:", this.leftHandMesh.position);
    console.log("Right hand:", this.rightHandMesh.position);

    // Increase physics precision further
    this.rapierWorld.timestep = 1 / 480; // Even more precise timestep
    this.rapierWorld.maxVelocityIterations = 64;
    this.rapierWorld.maxPositionIterations = 32;

    // Run more substeps
    for (let i = 0; i < 8; i++) {
      // Increased substeps
      this.rapierWorld.step();
    }

    // Update hand collider positions
    if (this.leftHandCollider && this.rightHandCollider) {
      const leftHandBodyHandle = this.leftHandCollider.parent();
      const rightHandBodyHandle = this.rightHandCollider.parent();

      if (
        leftHandBodyHandle !== null &&
        rightHandBodyHandle !== null &&
        typeof leftHandBodyHandle === "number" &&
        typeof rightHandBodyHandle === "number"
      ) {
        const leftHandBody = this.rapierWorld.getRigidBody(leftHandBodyHandle);
        const rightHandBody =
          this.rapierWorld.getRigidBody(rightHandBodyHandle);

        if (leftHandBody && rightHandBody) {
          leftHandBody.setTranslation(
            new RAPIER.Vector3(
              this.leftHandMesh.position.x,
              this.leftHandMesh.position.y,
              this.leftHandMesh.position.z
            ),
            true
          );
          rightHandBody.setTranslation(
            new RAPIER.Vector3(
              this.rightHandMesh.position.x,
              this.rightHandMesh.position.y,
              this.rightHandMesh.position.z
            ),
            true
          );
        } else {
          console.warn("Could not find rigid body for hand collider.");
        }
      } else {
        console.warn("Invalid hand body handle:", {
          leftHandBodyHandle,
          rightHandBodyHandle,
        });
      }
    }

    // Check for collisions
    for (const ball of this.balls) {
      if (this.leftHandCollider) {
        this.rapierWorld.contactPair(
          ball.collider,
          this.leftHandCollider,
          (manifold, flipped) => {
            this.handleHandCollision(ball, this.leftHandMesh.position);
          }
        );
      }
      if (this.rightHandCollider) {
        this.rapierWorld.contactPair(
          ball.collider,
          this.rightHandCollider,
          (manifold, flipped) => {
            this.handleHandCollision(ball, this.rightHandMesh.position);
          }
        );
      }
    }

    // Update ball positions with debug visualization
    this.balls = this.balls.filter((ball) => {
      const position = ball.body.translation();
      ball.mesh.position.set(position.x, position.y, position.z);

      // Debug visualization of ball trajectory
      console.log(`Ball velocity:`, ball.body.linvel());

      // Check for goal
      if (this.checkForGoal(position)) {
        this.goalsCount++;
        if (this.goalsCounter) {
          this.goalsCounter.textContent = `Goals: ${this.goalsCount}`;
        }
        this.scene.remove(ball.mesh);
        this.rapierWorld.removeRigidBody(ball.body);
        return false;
      }

      // Remove balls that are far behind the goal
      if (position.z < -10) {
        this.scene.remove(ball.mesh);
        this.rapierWorld.removeRigidBody(ball.body);
        return false;
      }
      return true;
    });

    this.renderer.render(this.scene, this.camera);
  }

  private handleHandCollision(
    ball: {
      body: RAPIER.RigidBody;
      mesh: THREE.Mesh;
      collider: RAPIER.Collider;
    },
    handPos: THREE.Vector3
  ) {
    console.log("handle hand collision");
    this.savesCount++;
    if (this.savesCounter) {
      this.savesCounter.textContent = `Saves: ${this.savesCount}`;
    }

    // Simplified deflection logic - always push ball away from goal
    ball.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    ball.body.setAngvel({ x: 0, y: 0, z: 0 }, true);

    const impulseMagnitude = 30; // Increased for stronger deflection
    ball.body.applyImpulse(
      {
        x: 0, // No horizontal deflection
        y: 0, // No vertical deflection
        z: impulseMagnitude, // Always push away from goal
      },
      true
    );
  }

  private checkForGoal(ballPosition: {
    x: number;
    y: number;
    z: number;
  }): boolean {
    return (
      ballPosition.x >= this.GOAL_BOUNDS.minX &&
      ballPosition.x <= this.GOAL_BOUNDS.maxX &&
      ballPosition.y >= this.GOAL_BOUNDS.minY &&
      ballPosition.y <= this.GOAL_BOUNDS.maxY &&
      Math.abs(ballPosition.z - this.GOAL_BOUNDS.z) < 0.5 // Check if ball is near goal plane
    );
  }
}

window.addEventListener("load", () => {
  new GoalkeeperGame();
});
