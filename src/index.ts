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
  private eventQueue: RAPIER.EventQueue;
  private updateLeftColliderVis: (() => void) | null = null;
  private updateRightColliderVis: (() => void) | null = null;

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

    const handGeometry = new THREE.SphereGeometry(1.2);
    this.leftHandMesh = new THREE.Mesh(handGeometry, bodyMaterial);
    this.rightHandMesh = new THREE.Mesh(handGeometry, bodyMaterial);
    this.leftHandMesh.position.set(-0.5, 1.6, 0);
    this.rightHandMesh.position.set(0.5, 1.6, 0);

    this.player.add(this.leftHandMesh, this.rightHandMesh);
    this.scene.add(this.player);

    // Create separate rigid bodies for each hand
    const leftHandBody = this.rapierWorld.createRigidBody(
      RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(-0.5, 1.6, 0)
    );

    const rightHandBody = this.rapierWorld.createRigidBody(
      RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(0.5, 1.6, 0)
    );

    const handColliderDesc = RAPIER.ColliderDesc.ball(this.handColliderSize)
      .setRestitution(1.5)
      .setFriction(0.5)
      .setSensor(false)
      .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);

    this.leftHandCollider = this.rapierWorld.createCollider(
      handColliderDesc,
      leftHandBody
    );

    this.rightHandCollider = this.rapierWorld.createCollider(
      handColliderDesc,
      rightHandBody
    );

    this.visualizeCollider(this.leftHandMesh, this.handColliderSize);
    this.visualizeCollider(this.rightHandMesh, this.handColliderSize);
    this.updateLeftColliderVis = this.visualizeColliderPosition(
      this.leftHandMesh,
      this.leftHandCollider
    );
    this.updateRightColliderVis = this.visualizeColliderPosition(
      this.rightHandMesh,
      this.rightHandCollider
    );
  }

  private visualizeColliderPosition(
    mesh: THREE.Mesh,
    collider: RAPIER.Collider
  ) {
    const geometry = new THREE.SphereGeometry(0.1); // Small sphere to mark position
    const material = new THREE.MeshBasicMaterial({ color: 0xffff00 }); // Yellow color
    const sphere = new THREE.Mesh(geometry, material);
    this.scene.add(sphere);

    // Update the sphere's position in the animate loop
    return () => {
      const position = collider.translation();
      sphere.position.set(position.x, position.y, position.z);
    };
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
      if (!landmarks || landmarks?.length < 33) {
        console.warn("Invalid landmarks data");
        return;
      }

      const leftHand = landmarks[16];
      const rightHand = landmarks[15];

      console.log("Left Hand Landmark:", leftHand);
      console.log("Right Hand Landmark:", rightHand);

      // Bring hands closer to camera by adjusting z position from -2 to 2
      this.leftHandMesh.position.set(
        leftHand.x * 20 - 10,
        (1 - leftHand.y) * 7,
        2 // Changed from -2 to 2 to bring hands closer
      );

      this.rightHandMesh.position.set(
        rightHand.x * 20 - 10,
        (1 - rightHand.y) * 7,
        2 // Changed from -2 to 2 to bring hands closer
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

    // Increase physics precision
    this.rapierWorld.timestep = 1 / 480;
    this.rapierWorld.maxVelocityIterations = 64;
    this.rapierWorld.maxPositionIterations = 32;

    // Run physics substeps
    for (let i = 0; i < 8; i++) {
      this.rapierWorld.step();
    }

    // Update hand collider positions
    if (this.leftHandCollider && this.rightHandCollider) {
      const leftHandBody = this.leftHandCollider.parent();
      const rightHandBody = this.rightHandCollider.parent();

      if (leftHandBody && rightHandBody) {
        // Ensure both hands are using the same coordinate space
        const leftPos = new RAPIER.Vector3(
          this.leftHandMesh.position.x,
          this.leftHandMesh.position.y,
          this.leftHandMesh.position.z
        );
        const rightPos = new RAPIER.Vector3(
          this.rightHandMesh.position.x,
          this.rightHandMesh.position.y,
          this.rightHandMesh.position.z
        );

        // Update both hand positions and wake the bodies
        leftHandBody.setTranslation(leftPos, true);
        rightHandBody.setTranslation(rightPos, true);
        leftHandBody.wakeUp();
        rightHandBody.wakeUp();
      }
    }

    // Collision event handling
    const eventQueue = this.rapierWorld.eventQueue;
    while (eventQueue?.length > 0) {
      const event = eventQueue.shift();
      if (event.type === RAPIER.EventType.COLLISION_EVENT) {
        const collisionEvent = event as RAPIER.CollisionEvent;
        const collider1 = collisionEvent.collider1();
        const collider2 = collisionEvent.collider2();

        // Add debug logging
        console.log(
          "Collision detected between:",
          collider1 === this.leftHandCollider
            ? "left hand"
            : collider1 === this.rightHandCollider
            ? "right hand"
            : "ball",
          "and",
          collider2 === this.leftHandCollider
            ? "left hand"
            : collider2 === this.rightHandCollider
            ? "right hand"
            : "ball"
        );

        // Try creating separate rigid bodies for each hand
        let handCollider: RAPIER.Collider | null = null;
        let ballCollider: RAPIER.Collider | null = null;

        if ([collider1, collider2].includes(this.leftHandCollider)) {
          handCollider = this.leftHandCollider;
          ballCollider = collider1 === handCollider ? collider2 : collider1;
        } else if ([collider1, collider2].includes(this.rightHandCollider)) {
          handCollider = this.rightHandCollider;
          ballCollider = collider1 === handCollider ? collider2 : collider1;
        }

        if (handCollider && ballCollider) {
          const ball = this.balls.find((b) => b.collider === ballCollider);
          if (ball) {
            const handMesh =
              handCollider === this.leftHandCollider
                ? this.leftHandMesh
                : this.rightHandMesh;
            console.log(
              "Processing collision with:",
              handCollider === this.leftHandCollider
                ? "left hand"
                : "right hand"
            );
            this.handleHandCollision(ball, handMesh.position);
          }
        }
      }
    }

    // Update ball positions with debug visualization
    this.balls = this.balls.filter((ball) => {
      const position = ball.body.translation();
      ball.mesh.position.set(position.x, position.y, position.z);

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
    if (this.updateLeftColliderVis) {
      this.updateLeftColliderVis();
    }
    if (this.updateRightColliderVis) {
      this.updateRightColliderVis();
    }
  }

  private handleHandCollision(
    ball: {
      body: RAPIER.RigidBody;
      mesh: THREE.Mesh;
      collider: RAPIER.Collider;
    },
    handPos: THREE.Vector3
  ) {
    console.log("Handle hand collision at position:", handPos);
    this.savesCount++;
    if (this.savesCounter) {
      this.savesCounter.textContent = `Saves: ${this.savesCount}`;
    }

    // Calculate deflection direction based on hand position
    const ballPos = ball.body.translation();
    const deflectionX = (ballPos.x - handPos.x) * 0.5; // Reduced horizontal influence
    const deflectionY = (ballPos.y - handPos.y) * 0.5; // Reduced vertical influence

    ball.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    ball.body.setAngvel({ x: 0, y: 0, z: 0 }, true);

    const impulseMagnitude = 20;
    ball.body.applyImpulse(
      {
        x: deflectionX * impulseMagnitude,
        y: deflectionY * impulseMagnitude,
        z: impulseMagnitude, // Base forward deflection
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
