# Kubernetes Cheatsheet

```sh
kubectl get pods -n staging
kubectl rollout restart deployment/api -n staging
kubectl logs -f deployment/api
```

Use `kubectl describe` when a pod is stuck in CrashLoopBackOff.
