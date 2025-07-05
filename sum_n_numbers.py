n = int(input("Enter a positive integer: "))
sum = 0
if n > 0:
    for i in range(1, n + 1):
        sum += i
    print(f"The sum of the First {n} natural numbers is: {sum}")
else:
    print("Please enter a positive integer.")
